/*
 * webrtc-gateway.c - WebRTC gateway for FrameBuffer
 *
 * Reads raw I420 frames from FrameBuffer via shared memory (shmsrc)
 * and streams them via WebRTC (webrtcbin) to browsers.
 *
 * Signaling is done via stdout/stdin JSON messages to communicate
 * with the Node.js signaling server.
 *
 * Usage: webrtc-gateway [options]
 *   -s <path>     Shared memory socket path (default: /tmp/framebuffer.sock)
 *   -w <width>    Video width (default: 640)
 *   -h <height>   Video height (default: 480)
 *   -f <fps>      Framerate (default: 25)
 *   -b <bitrate>  VP8 target bitrate in kbps (default: 2000)
 *   -t <stun>     STUN server URL (default: stun://stun.l.google.com:19302)
 *
 * JSON Protocol (stdin/stdout):
 *   Input:  {"type": "offer", "sdp": "..."}
 *           {"type": "ice", "candidate": "...", "sdpMLineIndex": 0}
 *   Output: {"type": "answer", "sdp": "..."}
 *           {"type": "ice", "candidate": "...", "sdpMLineIndex": 0}
 *           {"type": "ready"}
 *           {"type": "error", "message": "..."}
 */

#include <gst/gst.h>
#include <gst/webrtc/webrtc.h>
#include <gst/sdp/sdp.h>
#include <json-glib/json-glib.h>
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>

typedef struct {
    GMainLoop *loop;
    GstElement *pipeline;
    GstElement *webrtcbin;

    // Configuration
    gchar *shm_path;
    gint udp_port;      // UDP port for VP8 RTP input
    gint width;
    gint height;
    gint fps;
    gint bitrate;
    gchar *stun_server;

    // State
    gboolean negotiation_needed;
    GIOChannel *stdin_channel;
} WebRTCGateway;

static WebRTCGateway *gateway = NULL;

// Forward declarations
static void send_json_message(const gchar *type, JsonObject *data);
static void on_negotiation_needed(GstElement *webrtcbin, gpointer user_data);
static void on_ice_candidate(GstElement *webrtcbin, guint mlineindex, gchar *candidate, gpointer user_data);
static void on_ice_connection_state(GstElement *webrtcbin, GParamSpec *pspec, gpointer user_data);
static void handle_sdp_offer(const gchar *sdp_str);
static void handle_ice_candidate(const gchar *candidate, gint sdp_mline_index, const gchar *sdp_mid);

/*
 * Send a JSON message to stdout for Node.js signaling server
 */
static void send_json_message(const gchar *type, JsonObject *data) {
    JsonObject *msg = json_object_new();
    json_object_set_string_member(msg, "type", type);

    if (data) {
        GList *members = json_object_get_members(data);
        for (GList *l = members; l != NULL; l = l->next) {
            const gchar *name = l->data;
            JsonNode *node = json_object_dup_member(data, name);
            json_object_set_member(msg, name, node);
        }
        g_list_free(members);
    }

    JsonNode *root = json_node_new(JSON_NODE_OBJECT);
    json_node_set_object(root, msg);

    JsonGenerator *gen = json_generator_new();
    json_generator_set_root(gen, root);
    gchar *json_str = json_generator_to_data(gen, NULL);

    // Print to stdout with newline (Node.js reads line by line)
    printf("%s\n", json_str);
    fflush(stdout);

    g_free(json_str);
    g_object_unref(gen);
    json_node_free(root);
    json_object_unref(msg);
}

/*
 * Send error message
 */
static void send_error(const gchar *message) {
    JsonObject *data = json_object_new();
    json_object_set_string_member(data, "message", message);
    send_json_message("error", data);
    json_object_unref(data);
}

/*
 * Called when webrtcbin creates an answer
 */
static void on_answer_created(GstPromise *promise, gpointer user_data) {
    GstWebRTCSessionDescription *answer = NULL;
    const GstStructure *reply;

    g_assert(gst_promise_wait(promise) == GST_PROMISE_RESULT_REPLIED);
    reply = gst_promise_get_reply(promise);
    gst_structure_get(reply, "answer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &answer, NULL);
    gst_promise_unref(promise);

    if (!answer) {
        send_error("Failed to create answer");
        return;
    }

    // Set local description
    GstPromise *local_promise = gst_promise_new();
    g_signal_emit_by_name(gateway->webrtcbin, "set-local-description", answer, local_promise);
    gst_promise_interrupt(local_promise);
    gst_promise_unref(local_promise);

    // Send answer to signaling server
    gchar *sdp_str = gst_sdp_message_as_text(answer->sdp);

    JsonObject *data = json_object_new();
    json_object_set_string_member(data, "sdp", sdp_str);
    send_json_message("answer", data);
    json_object_unref(data);

    g_free(sdp_str);
    gst_webrtc_session_description_free(answer);
}

/*
 * Called when webrtcbin creates an offer (for renegotiation)
 */
static void on_offer_created(GstPromise *promise, gpointer user_data) {
    GstWebRTCSessionDescription *offer = NULL;
    const GstStructure *reply;

    g_printerr("on_offer_created called\n");

    GstPromiseResult result = gst_promise_wait(promise);
    if (result != GST_PROMISE_RESULT_REPLIED) {
        g_printerr("Promise result: %d (expected REPLIED=1)\n", result);
        send_error("Promise not replied");
        gst_promise_unref(promise);
        return;
    }

    reply = gst_promise_get_reply(promise);
    if (!reply) {
        g_printerr("No reply from promise\n");
        send_error("No reply from promise");
        gst_promise_unref(promise);
        return;
    }

    gst_structure_get(reply, "offer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &offer, NULL);
    gst_promise_unref(promise);

    if (!offer) {
        g_printerr("Failed to get offer from reply\n");
        send_error("Failed to create offer");
        return;
    }

    g_printerr("Offer created successfully\n");

    // Set local description
    GstPromise *local_promise = gst_promise_new();
    g_signal_emit_by_name(gateway->webrtcbin, "set-local-description", offer, local_promise);
    gst_promise_interrupt(local_promise);
    gst_promise_unref(local_promise);

    // Send offer to signaling server
    gchar *sdp_str = gst_sdp_message_as_text(offer->sdp);

    g_printerr("Sending offer to signaling server (SDP length: %lu)\n", strlen(sdp_str));

    JsonObject *data = json_object_new();
    json_object_set_string_member(data, "sdp", sdp_str);
    send_json_message("offer", data);
    json_object_unref(data);

    g_printerr("Offer sent\n");

    g_free(sdp_str);
    gst_webrtc_session_description_free(offer);
}

/*
 * Handle incoming SDP offer from browser
 */
static void handle_sdp_offer(const gchar *sdp_str) {
    GstSDPMessage *sdp;
    GstWebRTCSessionDescription *offer;

    if (gst_sdp_message_new(&sdp) != GST_SDP_OK) {
        send_error("Failed to create SDP message");
        return;
    }

    if (gst_sdp_message_parse_buffer((guint8 *)sdp_str, strlen(sdp_str), sdp) != GST_SDP_OK) {
        send_error("Failed to parse SDP offer");
        gst_sdp_message_free(sdp);
        return;
    }

    offer = gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_OFFER, sdp);

    // Set remote description
    GstPromise *promise = gst_promise_new();
    g_signal_emit_by_name(gateway->webrtcbin, "set-remote-description", offer, promise);
    gst_promise_interrupt(promise);
    gst_promise_unref(promise);

    gst_webrtc_session_description_free(offer);

    // Create answer
    promise = gst_promise_new_with_change_func(on_answer_created, NULL, NULL);
    g_signal_emit_by_name(gateway->webrtcbin, "create-answer", NULL, promise);
}

/*
 * Handle incoming SDP answer from browser
 */
static void handle_sdp_answer(const gchar *sdp_str) {
    GstSDPMessage *sdp;
    GstWebRTCSessionDescription *answer;

    if (gst_sdp_message_new(&sdp) != GST_SDP_OK) {
        send_error("Failed to create SDP message");
        return;
    }

    if (gst_sdp_message_parse_buffer((guint8 *)sdp_str, strlen(sdp_str), sdp) != GST_SDP_OK) {
        send_error("Failed to parse SDP answer");
        gst_sdp_message_free(sdp);
        return;
    }

    answer = gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_ANSWER, sdp);

    // Set remote description
    GstPromise *promise = gst_promise_new();
    g_signal_emit_by_name(gateway->webrtcbin, "set-remote-description", answer, promise);
    gst_promise_interrupt(promise);
    gst_promise_unref(promise);

    gst_webrtc_session_description_free(answer);
}

/*
 * Handle incoming ICE candidate from browser
 */
static void handle_ice_candidate(const gchar *candidate, gint sdp_mline_index, const gchar *sdp_mid) {
    g_signal_emit_by_name(gateway->webrtcbin, "add-ice-candidate", sdp_mline_index, candidate);
}

/*
 * Called when negotiation is needed (webrtcbin signal)
 */
static void on_negotiation_needed(GstElement *webrtcbin, gpointer user_data) {
    g_printerr("Negotiation needed - creating offer...\n");
    gateway->negotiation_needed = TRUE;

    // Create offer
    GstPromise *promise = gst_promise_new_with_change_func(on_offer_created, NULL, NULL);
    if (!promise) {
        g_printerr("Failed to create promise for offer\n");
        return;
    }
    g_printerr("Calling create-offer on webrtcbin...\n");
    g_signal_emit_by_name(webrtcbin, "create-offer", NULL, promise);
    g_printerr("create-offer signal emitted\n");
}

/*
 * Called when a new ICE candidate is generated
 */
static void on_ice_candidate(GstElement *webrtcbin, guint mlineindex, gchar *candidate, gpointer user_data) {
    JsonObject *data = json_object_new();
    json_object_set_string_member(data, "candidate", candidate);
    json_object_set_int_member(data, "sdpMLineIndex", mlineindex);
    send_json_message("ice", data);
    json_object_unref(data);
}

/*
 * Called when ICE connection state changes
 */
static void on_ice_connection_state(GstElement *webrtcbin, GParamSpec *pspec, gpointer user_data) {
    GstWebRTCICEConnectionState state;
    g_object_get(webrtcbin, "ice-connection-state", &state, NULL);

    const gchar *state_str;
    switch (state) {
        case GST_WEBRTC_ICE_CONNECTION_STATE_NEW: state_str = "new"; break;
        case GST_WEBRTC_ICE_CONNECTION_STATE_CHECKING: state_str = "checking"; break;
        case GST_WEBRTC_ICE_CONNECTION_STATE_CONNECTED: state_str = "connected"; break;
        case GST_WEBRTC_ICE_CONNECTION_STATE_COMPLETED: state_str = "completed"; break;
        case GST_WEBRTC_ICE_CONNECTION_STATE_FAILED: state_str = "failed"; break;
        case GST_WEBRTC_ICE_CONNECTION_STATE_DISCONNECTED: state_str = "disconnected"; break;
        case GST_WEBRTC_ICE_CONNECTION_STATE_CLOSED: state_str = "closed"; break;
        default: state_str = "unknown"; break;
    }

    g_printerr("ICE connection state: %s\n", state_str);

    JsonObject *data = json_object_new();
    json_object_set_string_member(data, "state", state_str);
    send_json_message("ice-state", data);
    json_object_unref(data);
}

/*
 * Called when connection state changes
 */
static void on_connection_state(GstElement *webrtcbin, GParamSpec *pspec, gpointer user_data) {
    GstWebRTCPeerConnectionState state;
    g_object_get(webrtcbin, "connection-state", &state, NULL);

    const gchar *state_str;
    switch (state) {
        case GST_WEBRTC_PEER_CONNECTION_STATE_NEW: state_str = "new"; break;
        case GST_WEBRTC_PEER_CONNECTION_STATE_CONNECTING: state_str = "connecting"; break;
        case GST_WEBRTC_PEER_CONNECTION_STATE_CONNECTED: state_str = "connected"; break;
        case GST_WEBRTC_PEER_CONNECTION_STATE_DISCONNECTED: state_str = "disconnected"; break;
        case GST_WEBRTC_PEER_CONNECTION_STATE_FAILED: state_str = "failed"; break;
        case GST_WEBRTC_PEER_CONNECTION_STATE_CLOSED: state_str = "closed"; break;
        default: state_str = "unknown"; break;
    }

    g_printerr("Connection state: %s\n", state_str);

    JsonObject *data = json_object_new();
    json_object_set_string_member(data, "state", state_str);
    send_json_message("connection-state", data);
    json_object_unref(data);
}

/*
 * Process incoming JSON message from stdin
 */
static void process_message(const gchar *json_str) {
    JsonParser *parser = json_parser_new();
    GError *error = NULL;

    if (!json_parser_load_from_data(parser, json_str, -1, &error)) {
        g_printerr("Failed to parse JSON: %s\n", error->message);
        g_error_free(error);
        g_object_unref(parser);
        return;
    }

    JsonNode *root = json_parser_get_root(parser);
    JsonObject *obj = json_node_get_object(root);

    const gchar *type = json_object_get_string_member(obj, "type");

    if (g_strcmp0(type, "offer") == 0) {
        const gchar *sdp = json_object_get_string_member(obj, "sdp");
        if (sdp) {
            handle_sdp_offer(sdp);
        }
    } else if (g_strcmp0(type, "answer") == 0) {
        const gchar *sdp = json_object_get_string_member(obj, "sdp");
        if (sdp) {
            handle_sdp_answer(sdp);
        }
    } else if (g_strcmp0(type, "ice") == 0) {
        const gchar *candidate = json_object_get_string_member(obj, "candidate");
        gint64 sdp_mline_index = json_object_get_int_member(obj, "sdpMLineIndex");
        const gchar *sdp_mid = NULL;
        if (json_object_has_member(obj, "sdpMid")) {
            sdp_mid = json_object_get_string_member(obj, "sdpMid");
        }
        if (candidate) {
            handle_ice_candidate(candidate, (gint)sdp_mline_index, sdp_mid);
        }
    } else if (g_strcmp0(type, "start") == 0) {
        // Start the pipeline
        gst_element_set_state(gateway->pipeline, GST_STATE_PLAYING);
    } else if (g_strcmp0(type, "stop") == 0) {
        // Stop the pipeline
        gst_element_set_state(gateway->pipeline, GST_STATE_NULL);
    } else {
        g_printerr("Unknown message type: %s\n", type);
    }

    g_object_unref(parser);
}

/*
 * Read stdin callback
 */
static gboolean stdin_callback(GIOChannel *channel, GIOCondition condition, gpointer user_data) {
    if (condition & G_IO_HUP) {
        g_printerr("stdin closed, exiting\n");
        g_main_loop_quit(gateway->loop);
        return FALSE;
    }

    gchar *line = NULL;
    gsize length;
    GError *error = NULL;

    GIOStatus status = g_io_channel_read_line(channel, &line, &length, NULL, &error);

    if (status == G_IO_STATUS_NORMAL && line) {
        // Remove trailing newline
        if (length > 0 && line[length - 1] == '\n') {
            line[length - 1] = '\0';
        }
        process_message(line);
        g_free(line);
    } else if (status == G_IO_STATUS_EOF) {
        g_printerr("EOF on stdin, exiting\n");
        g_main_loop_quit(gateway->loop);
        return FALSE;
    } else if (error) {
        g_printerr("Error reading stdin: %s\n", error->message);
        g_error_free(error);
    }

    return TRUE;
}

/*
 * Bus message handler
 */
static gboolean bus_callback(GstBus *bus, GstMessage *message, gpointer user_data) {
    switch (GST_MESSAGE_TYPE(message)) {
        case GST_MESSAGE_ERROR: {
            GError *err;
            gchar *debug;
            gst_message_parse_error(message, &err, &debug);
            g_printerr("Pipeline error: %s\n", err->message);
            send_error(err->message);
            g_error_free(err);
            g_free(debug);
            g_main_loop_quit(gateway->loop);
            break;
        }
        case GST_MESSAGE_WARNING: {
            GError *err;
            gchar *debug;
            gst_message_parse_warning(message, &err, &debug);
            g_printerr("Pipeline warning: %s\n", err->message);
            g_error_free(err);
            g_free(debug);
            break;
        }
        case GST_MESSAGE_STATE_CHANGED: {
            if (GST_MESSAGE_SRC(message) == GST_OBJECT(gateway->pipeline)) {
                GstState old, new, pending;
                gst_message_parse_state_changed(message, &old, &new, &pending);
                g_printerr("Pipeline state: %s -> %s\n",
                    gst_element_state_get_name(old),
                    gst_element_state_get_name(new));
            }
            break;
        }
        case GST_MESSAGE_EOS:
            g_printerr("End of stream\n");
            send_json_message("eos", NULL);
            break;
        default:
            break;
    }
    return TRUE;
}

/*
 * Create the GStreamer pipeline
 */
static gboolean create_pipeline(void) {
    GError *error = NULL;

    // Pipeline: udpsrc → rtpjitterbuffer → rtpvp8depay → rtpvp8pay (re-timestamp) → webrtcbin
    // Passthrough VP8 sans ré-encodage, mais avec re-timestamp pour WebRTC
    gchar *pipeline_str = g_strdup_printf(
        "udpsrc port=%d caps=\"application/x-rtp,media=video,encoding-name=VP8,payload=96,clock-rate=90000\" "
        "! rtpjitterbuffer latency=100 do-retransmission=false "
        "! rtpvp8depay "
        "! rtpvp8pay pt=96 picture-id-mode=2 "
        "! application/x-rtp,media=video,encoding-name=VP8,payload=96,clock-rate=90000 "
        "! webrtcbin name=webrtcbin bundle-policy=max-bundle stun-server=%s",
        gateway->udp_port,
        gateway->stun_server
    );

    g_printerr("Creating pipeline: %s\n", pipeline_str);

    gateway->pipeline = gst_parse_launch(pipeline_str, &error);
    g_free(pipeline_str);

    if (error) {
        g_printerr("Failed to create pipeline: %s\n", error->message);
        send_error(error->message);
        g_error_free(error);
        return FALSE;
    }

    // Get webrtcbin element
    gateway->webrtcbin = gst_bin_get_by_name(GST_BIN(gateway->pipeline), "webrtcbin");
    if (!gateway->webrtcbin) {
        g_printerr("Failed to get webrtcbin element\n");
        send_error("Failed to get webrtcbin element");
        return FALSE;
    }

    // Connect signals
    g_signal_connect(gateway->webrtcbin, "on-negotiation-needed",
        G_CALLBACK(on_negotiation_needed), NULL);
    g_signal_connect(gateway->webrtcbin, "on-ice-candidate",
        G_CALLBACK(on_ice_candidate), NULL);
    g_signal_connect(gateway->webrtcbin, "notify::ice-connection-state",
        G_CALLBACK(on_ice_connection_state), NULL);
    g_signal_connect(gateway->webrtcbin, "notify::connection-state",
        G_CALLBACK(on_connection_state), NULL);

    // Add bus watch
    GstBus *bus = gst_element_get_bus(gateway->pipeline);
    gst_bus_add_watch(bus, bus_callback, NULL);
    gst_object_unref(bus);

    return TRUE;
}

/*
 * Print usage
 */
static void print_usage(const char *prog) {
    g_printerr("Usage: %s [options]\n", prog);
    g_printerr("Options:\n");
    g_printerr("  -p <port>     UDP port for VP8 RTP input (default: 5002)\n");
    g_printerr("  -t <stun>     STUN server URL (default: stun://stun.l.google.com:19302)\n");
    g_printerr("  --help        Show this help\n");
}

int main(int argc, char *argv[]) {
    // Initialize GStreamer
    gst_init(&argc, &argv);

    // Create gateway structure
    gateway = g_new0(WebRTCGateway, 1);
    gateway->udp_port = 5002;
    gateway->stun_server = g_strdup("stun://stun.l.google.com:19302");
    gateway->negotiation_needed = FALSE;

    // Parse arguments
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-p") == 0 && i + 1 < argc) {
            gateway->udp_port = atoi(argv[++i]);
        } else if (strcmp(argv[i], "-t") == 0 && i + 1 < argc) {
            g_free(gateway->stun_server);
            gateway->stun_server = g_strdup(argv[++i]);
        } else if (strcmp(argv[i], "--help") == 0) {
            print_usage(argv[0]);
            return 0;
        }
    }

    g_printerr("WebRTC Gateway starting\n");
    g_printerr("  UDP port: %d (VP8 RTP input)\n", gateway->udp_port);
    g_printerr("  STUN: %s\n", gateway->stun_server);

    // Create main loop
    gateway->loop = g_main_loop_new(NULL, FALSE);

    // Create pipeline
    if (!create_pipeline()) {
        g_printerr("Failed to create pipeline\n");
        return 1;
    }

    // Set up stdin reading
    gateway->stdin_channel = g_io_channel_unix_new(STDIN_FILENO);
    g_io_channel_set_flags(gateway->stdin_channel, G_IO_FLAG_NONBLOCK, NULL);
    g_io_add_watch(gateway->stdin_channel, G_IO_IN | G_IO_HUP, stdin_callback, NULL);

    // Signal that we're ready
    send_json_message("ready", NULL);

    // The pipeline will be started when we receive a "start" message
    // or when negotiation completes

    // Run main loop
    g_main_loop_run(gateway->loop);

    // Cleanup
    gst_element_set_state(gateway->pipeline, GST_STATE_NULL);
    gst_object_unref(gateway->pipeline);
    g_io_channel_unref(gateway->stdin_channel);
    g_main_loop_unref(gateway->loop);
    g_free(gateway->shm_path);
    g_free(gateway->stun_server);
    g_free(gateway);

    return 0;
}
