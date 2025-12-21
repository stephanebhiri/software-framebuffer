/**
 * FrameBuffer - Ultra-stable video frame synchronizer
 *
 * Concept: Decoupled input/output with render loop
 * - Input: Receives frames whenever they arrive (chaotic)
 * - Buffer: Stores the last good frame
 * - Output: Renders at exactly 25fps (rock-solid)
 *
 * Like a camera filming a cinema screen - output is always stable.
 */

#include <gst/gst.h>
#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    // Pipelines
    GstElement *input_pipeline;
    GstElement *output_pipeline;

    // Key elements
    GstElement *appsink;      // Receives decoded frames
    GstElement *appsrc;       // Pushes frames at fixed rate

    // Frame buffer (single frame, mutex protected)
    GstBuffer *current_frame;
    GstCaps *current_caps;
    GMutex frame_mutex;

    // Render loop
    GThread *render_thread;
    gboolean running;

    // Stats
    guint64 frames_in;
    guint64 frames_out;
    guint64 frames_repeated;
    guint64 in_seq;           // Incremented each new frame received
    guint64 last_pushed_seq;  // Last sequence number pushed to output

    // Config
    gint input_port;
    gint output_port;
    gchar *output_host;
    gint width;
    gint height;
    gint fps;
    gint bitrate;
    gboolean raw_output;  // Output raw video instead of H.264 MPEG-TS
    gboolean vp8_output;  // Output VP8 RTP (for direct WebRTC)
    gboolean shm_output;  // Output raw I420 via shared memory (for webrtc-gateway)
    gchar *shm_path;      // Shared memory socket path

    GMainLoop *loop;
} FrameBuffer;

// Forward declarations
static GstFlowReturn on_new_sample(GstElement *sink, FrameBuffer *fb);
static gpointer render_loop(gpointer data);
static GstBuffer *create_fallback_frame(FrameBuffer *fb);
static void on_bus_error(GstBus *bus, GstMessage *msg, gpointer data);
static void on_demux_pad_added(GstElement *demux, GstPad *pad, gpointer data);

/**
 * Bus error handler
 */
static void on_bus_error(GstBus *bus, GstMessage *msg, gpointer data) {
    const char *pipeline_name = (const char *)data;
    GError *err = NULL;
    gchar *debug = NULL;

    gst_message_parse_error(msg, &err, &debug);
    g_printerr("[FrameBuffer] %s ERROR: %s\n", pipeline_name, err->message);
    if (debug) {
        g_printerr("[FrameBuffer] Debug: %s\n", debug);
    }
    g_error_free(err);
    g_free(debug);
}

/**
 * Context for safe source switching via pad probe
 */
typedef struct {
    GstPad *new_pad;   // New video pad from tsdemux (any codec)
} SwitchContext;

// Forward declarations
static void on_demux_pad_added(GstElement *demux, GstPad *pad, gpointer data);

/**
 * Configure decoder properties for optimal performance
 */
static void configure_decoder(GstElement *decoder, const gchar *codec_name) {
    // Enable multi-threading for FFmpeg decoders
    if (g_object_class_find_property(G_OBJECT_GET_CLASS(decoder), "max-threads")) {
        g_object_set(decoder, "max-threads", 0, NULL);
        g_print("[FrameBuffer] Enabled multi-threading on %s\n", codec_name);
    }
}

/**
 * Pad probe callback for safe source switching
 * Called when the sink pad is blocked - safe to unlink/link
 */
static GstPadProbeReturn
on_switch_blocked(GstPad *qsink,
                  GstPadProbeInfo *info,
                  gpointer user_data)
{
    SwitchContext *ctx = (SwitchContext *)user_data;

    g_print("[FrameBuffer] Sink pad blocked, performing source switch\n");

    /* Unlink old peer if any */
    GstPad *old_peer = gst_pad_get_peer(qsink);
    if (old_peer) {
        g_print("[FrameBuffer] Unlinking old video pad\n");
        gst_pad_unlink(old_peer, qsink);
        gst_object_unref(old_peer);
    }

    /* Link new pad */
    GstPadLinkReturn ret = gst_pad_link(ctx->new_pad, qsink);
    if (ret == GST_PAD_LINK_OK) {
        g_print("[FrameBuffer] Linked new video pad successfully\n");
    } else {
        g_printerr("[FrameBuffer] Failed to link new video pad: %d\n", ret);
    }

    /* Cleanup */
    gst_object_unref(ctx->new_pad);
    g_free(ctx);

    /* Remove the probe and unblock dataflow */
    return GST_PAD_PROBE_REMOVE;
}

/**
 * Check if caps represent a video format (any codec)
 */
static gboolean is_video_caps(const gchar *caps_name) {
    return (g_str_has_prefix(caps_name, "video/x-h264") ||
            g_str_has_prefix(caps_name, "video/x-h265") ||
            g_str_has_prefix(caps_name, "video/mpeg") ||
            g_str_has_prefix(caps_name, "video/x-vp8") ||
            g_str_has_prefix(caps_name, "video/x-vp9") ||
            g_str_has_prefix(caps_name, "video/x-av1") ||
            g_str_has_prefix(caps_name, "video/x-raw"));
}

/**
 * Helper to link a pad to a new fakesink
 */
static void link_pad_to_fakesink(GstElement *demux, GstPad *pad) {
    GstElement *pipeline = GST_ELEMENT(gst_element_get_parent(demux));
    if (pipeline) {
        GstElement *fakesink = gst_element_factory_make("fakesink", NULL);
        if (fakesink) {
            g_object_set(fakesink, "sync", FALSE, "async", FALSE, NULL);
            gst_bin_add(GST_BIN(pipeline), fakesink);
            gst_element_sync_state_with_parent(fakesink);

            GstPad *fsink = gst_element_get_static_pad(fakesink, "sink");
            if (fsink) {
                gst_pad_link(pad, fsink);
                gst_object_unref(fsink);
            }
        }
        gst_object_unref(pipeline);
    }
}

/**
 * Handle new pads from tsdemux - create explicit decoder based on codec
 * Uses avdec_mpeg2video for MPEG2, avdec_h264 for H.264, etc.
 */
static void on_demux_pad_added(GstElement *demux, GstPad *pad, gpointer data) {
    GstElement *videoconvert = (GstElement *)data;
    GstElement *pipeline = GST_ELEMENT(gst_element_get_parent(demux));

    GstCaps *caps = gst_pad_get_current_caps(pad);
    if (!caps) caps = gst_pad_query_caps(pad, NULL);
    if (!caps) {
        if (pipeline) gst_object_unref(pipeline);
        return;
    }

    const GstStructure *s = gst_caps_get_structure(caps, 0);
    const gchar *name = gst_structure_get_name(s);

    g_print("[FrameBuffer] Demux pad: %s (%s)\n", GST_PAD_NAME(pad), name);

    gboolean handled = FALSE;

    if (is_video_caps(name)) {
        GstElement *decoder = NULL;
        const gchar *decoder_name = NULL;

        // Select explicit decoder based on codec
        if (g_strcmp0(name, "video/mpeg") == 0) {
            gint mpegversion = 0;
            gst_structure_get_int(s, "mpegversion", &mpegversion);
            if (mpegversion == 2) {
                decoder = gst_element_factory_make("avdec_mpeg2video", "decoder");
                decoder_name = "avdec_mpeg2video";
            } else if (mpegversion == 4) {
                decoder = gst_element_factory_make("avdec_mpeg4", "decoder");
                decoder_name = "avdec_mpeg4";
            }
        } else if (g_strcmp0(name, "video/x-h264") == 0) {
            decoder = gst_element_factory_make("avdec_h264", "decoder");
            decoder_name = "avdec_h264";
        } else if (g_strcmp0(name, "video/x-h265") == 0) {
            decoder = gst_element_factory_make("avdec_h265", "decoder");
            decoder_name = "avdec_h265";
        }

        if (decoder) {
            g_print("[FrameBuffer] Using explicit decoder: %s\n", decoder_name);

            // Configure decoder for performance
            configure_decoder(decoder, decoder_name);

            // Add decoder to pipeline
            gst_bin_add(GST_BIN(pipeline), decoder);
            gst_element_sync_state_with_parent(decoder);

            // Link: tsdemux pad -> decoder -> videoconvert
            GstPad *decoder_sink = gst_element_get_static_pad(decoder, "sink");
            GstPad *decoder_src = gst_element_get_static_pad(decoder, "src");
            GstPad *vc_sink = gst_element_get_static_pad(videoconvert, "sink");

            if (decoder_sink && decoder_src && vc_sink) {
                GstPadLinkReturn ret1 = gst_pad_link(pad, decoder_sink);
                GstPadLinkReturn ret2 = gst_pad_link(decoder_src, vc_sink);

                if (ret1 == GST_PAD_LINK_OK && ret2 == GST_PAD_LINK_OK) {
                    g_print("[FrameBuffer] Linked: tsdemux -> %s -> videoconvert\n", decoder_name);
                    handled = TRUE;
                } else {
                    g_printerr("[FrameBuffer] Link failed: ret1=%d ret2=%d\n", ret1, ret2);
                }
            }

            if (decoder_sink) gst_object_unref(decoder_sink);
            if (decoder_src) gst_object_unref(decoder_src);
            if (vc_sink) gst_object_unref(vc_sink);
        } else {
            g_printerr("[FrameBuffer] No decoder for codec: %s\n", name);
        }
    }

    // Non-video pads (and failed links) go to fakesink
    if (!handled && !is_video_caps(name)) {
        link_pad_to_fakesink(demux, pad);
    }

    gst_caps_unref(caps);
    if (pipeline) gst_object_unref(pipeline);
}

/**
 * Initialize frame buffer
 */
static FrameBuffer *framebuffer_new(void) {
    FrameBuffer *fb = g_new0(FrameBuffer, 1);
    g_mutex_init(&fb->frame_mutex);
    fb->running = FALSE;
    fb->current_frame = NULL;
    fb->current_caps = NULL;

    // Defaults
    fb->input_port = 5001;
    fb->output_port = 5002;
    fb->output_host = g_strdup("127.0.0.1");
    fb->width = 640;
    fb->height = 480;
    fb->fps = 25;
    fb->bitrate = 2000;
    fb->raw_output = FALSE;
    fb->vp8_output = FALSE;
    fb->shm_output = FALSE;
    fb->shm_path = g_strdup("/tmp/framebuffer.sock");

    return fb;
}

/**
 * Create input pipeline: UDP/MPEG-TS -> decode -> appsink
 * Built programmatically with explicit decoder selection (no decodebin3)
 * Decoder is created dynamically in on_demux_pad_added based on detected codec
 */
static gboolean create_input_pipeline(FrameBuffer *fb) {
    fb->input_pipeline = gst_pipeline_new("input-pipeline");

    // Create elements - decoder will be added dynamically based on codec
    GstElement *udpsrc = gst_element_factory_make("udpsrc", "udpsrc");
    GstElement *tsdemux = gst_element_factory_make("tsdemux", "tsdemux");
    GstElement *videoconvert = gst_element_factory_make("videoconvert", "videoconvert");
    GstElement *videoscale = gst_element_factory_make("videoscale", "videoscale");
    GstElement *capsfilter = gst_element_factory_make("capsfilter", "capsfilter");
    fb->appsink = gst_element_factory_make("appsink", "sink");

    if (!udpsrc || !tsdemux ||
        !videoconvert || !videoscale || !capsfilter || !fb->appsink) {
        g_printerr("[FrameBuffer] Failed to create input elements\n");
        return FALSE;
    }

    // Configure udpsrc with MPEG-TS caps
    GstCaps *src_caps = gst_caps_from_string(
        "video/mpegts,systemstream=(boolean)true,packetsize=(int)188");
    g_object_set(udpsrc,
        "port", fb->input_port,
        "buffer-size", 2097152,
        "caps", src_caps,
        NULL);
    gst_caps_unref(src_caps);

    // Configure capsfilter
    gchar *caps_str = g_strdup_printf(
        "video/x-raw,format=I420,width=%d,height=%d",
        fb->width, fb->height);
    GstCaps *caps = gst_caps_from_string(caps_str);
    g_object_set(capsfilter, "caps", caps, NULL);
    gst_caps_unref(caps);
    g_free(caps_str);

    // Configure appsink
    g_object_set(fb->appsink,
        "emit-signals", TRUE,
        "sync", FALSE,
        "max-buffers", 2,
        "drop", TRUE,
        NULL);

    // Add elements to pipeline (decoder added dynamically later)
    gst_bin_add_many(GST_BIN(fb->input_pipeline),
        udpsrc, tsdemux,
        videoconvert, videoscale, capsfilter, fb->appsink, NULL);

    // Link static elements: udpsrc -> tsdemux
    if (!gst_element_link(udpsrc, tsdemux)) {
        g_printerr("[FrameBuffer] Failed to link udpsrc to tsdemux\n");
        return FALSE;
    }

    // Link post-decode chain: videoconvert -> videoscale -> capsfilter -> appsink
    if (!gst_element_link_many(videoconvert, videoscale, capsfilter, fb->appsink, NULL)) {
        g_printerr("[FrameBuffer] Failed to link post-decode chain\n");
        return FALSE;
    }

    // Connect to tsdemux's pad-added signal - will create decoder and link to videoconvert
    g_signal_connect(tsdemux, "pad-added", G_CALLBACK(on_demux_pad_added), videoconvert);

    // Connect appsink signal
    g_signal_connect(fb->appsink, "new-sample", G_CALLBACK(on_new_sample), fb);

    // Add bus watch for errors
    GstBus *bus = gst_pipeline_get_bus(GST_PIPELINE(fb->input_pipeline));
    gst_bus_add_signal_watch(bus);
    g_signal_connect(bus, "message::error", G_CALLBACK(on_bus_error), (gpointer)"INPUT");
    gst_object_unref(bus);

    g_print("[FrameBuffer] Input pipeline created (port %d)\n", fb->input_port);
    return TRUE;
}

/**
 * Create output pipeline: appsrc -> encode/passthrough -> output
 * Supports four modes:
 * - H.264 MPEG-TS (default): appsrc -> x264enc -> mpegtsmux -> udpsink
 * - Raw RTP (-r flag):       appsrc -> rtpvrawpay -> udpsink
 * - VP8 RTP (-v flag):       appsrc -> vp8enc -> rtpvp8pay -> udpsink
 * - SHM (-s flag):           appsrc -> shmsink (raw I420 for webrtc-gateway)
 */
static gboolean create_output_pipeline(FrameBuffer *fb) {
    gchar *caps_str = g_strdup_printf(
        "video/x-raw,format=I420,width=%d,height=%d,framerate=%d/1",
        fb->width, fb->height, fb->fps
    );

    gchar *pipeline_str;
    const gchar *mode_name;

    if (fb->shm_output) {
        // Shared memory output - raw I420 for webrtc-gateway
        // Zero-copy handoff to separate WebRTC process
        pipeline_str = g_strdup_printf(
            "appsrc name=src is-live=true format=time do-timestamp=true "
            "caps=\"%s\" "
            "! shmsink socket-path=%s sync=false wait-for-connection=false shm-size=10000000",
            caps_str, fb->shm_path
        );
        mode_name = "SHM (raw I420)";
    } else if (fb->vp8_output) {
        // VP8 RTP output - WebRTC-ready, single encode
        pipeline_str = g_strdup_printf(
            "appsrc name=src is-live=true format=time do-timestamp=true "
            "caps=\"%s\" "
            "! videoconvert "
            "! vp8enc deadline=1 cpu-used=4 target-bitrate=%d000 keyframe-max-dist=5 "
            "! rtpvp8pay mtu=1200 "
            "! udpsink host=%s port=%d sync=false",
            caps_str, fb->bitrate, fb->output_host, fb->output_port
        );
        mode_name = "VP8 RTP";
    } else if (fb->raw_output) {
        // Raw RTP output - no encoding, minimal latency
        pipeline_str = g_strdup_printf(
            "appsrc name=src is-live=true format=time do-timestamp=true "
            "caps=\"%s\" "
            "! rtpvrawpay mtu=1400 "
            "! udpsink host=%s port=%d sync=false",
            caps_str, fb->output_host, fb->output_port
        );
        mode_name = "RAW RTP";
    } else {
        // H.264 MPEG-TS output (default)
        pipeline_str = g_strdup_printf(
            "appsrc name=src is-live=true format=time do-timestamp=false "
            "caps=\"%s\" "
            "! videoconvert "
            "! x264enc tune=zerolatency speed-preset=ultrafast bitrate=%d key-int-max=%d "
            "! h264parse "
            "! mpegtsmux "
            "! udpsink host=%s port=%d sync=false",
            caps_str, fb->bitrate, fb->fps, fb->output_host, fb->output_port
        );
        mode_name = "H.264 MPEG-TS";
    }

    g_free(caps_str);

    GError *error = NULL;
    fb->output_pipeline = gst_parse_launch(pipeline_str, &error);
    g_free(pipeline_str);

    if (error) {
        g_printerr("[FrameBuffer] Output pipeline error: %s\n", error->message);
        g_error_free(error);
        return FALSE;
    }

    // Get appsrc
    fb->appsrc = gst_bin_get_by_name(GST_BIN(fb->output_pipeline), "src");

    if (fb->shm_output) {
        g_print("[FrameBuffer] Output pipeline created (%s @ %dfps, %s)\n",
                fb->shm_path, fb->fps, mode_name);
    } else {
        g_print("[FrameBuffer] Output pipeline created (%s:%d @ %dfps, %s)\n",
                fb->output_host, fb->output_port, fb->fps, mode_name);
    }
    return TRUE;
}

/**
 * Called when a new frame arrives from input
 * Accept all frames - the render loop imposes proper timing on output
 * Note: CORRUPTED flag is unreliable, so we don't filter on it
 */
static GstFlowReturn on_new_sample(GstElement *sink, FrameBuffer *fb) {
    GstSample *sample = gst_app_sink_pull_sample(GST_APP_SINK(sink));
    if (!sample) return GST_FLOW_ERROR;

    GstBuffer *buffer = gst_sample_get_buffer(sample);
    GstCaps *caps = gst_sample_get_caps(sample);

    g_mutex_lock(&fb->frame_mutex);

    // Replace current frame
    if (fb->current_frame) {
        gst_buffer_unref(fb->current_frame);
    }
    fb->current_frame = gst_buffer_ref(buffer);

    // Update caps if changed
    if (caps && (!fb->current_caps || !gst_caps_is_equal(caps, fb->current_caps))) {
        if (fb->current_caps) gst_caps_unref(fb->current_caps);
        fb->current_caps = gst_caps_ref(caps);
    }

    fb->frames_in++;
    fb->in_seq++;  // Increment sequence for repeat detection

    g_mutex_unlock(&fb->frame_mutex);

    gst_sample_unref(sample);

    return GST_FLOW_OK;
}

/**
 * Create a simple fallback frame (gray with "NO SIGNAL" concept)
 */
static GstBuffer *create_fallback_frame(FrameBuffer *fb) {
    gsize y_size = fb->width * fb->height;
    gsize uv_size = y_size / 4;
    gsize total_size = y_size + 2 * uv_size;  // I420 format

    GstBuffer *buffer = gst_buffer_new_allocate(NULL, total_size, NULL);

    GstMapInfo map;
    gst_buffer_map(buffer, &map, GST_MAP_WRITE);

    // Y plane: gray (128)
    memset(map.data, 128, y_size);

    // U and V planes: neutral (128)
    memset(map.data + y_size, 128, uv_size);
    memset(map.data + y_size + uv_size, 128, uv_size);

    gst_buffer_unmap(buffer, &map);

    return buffer;
}

/**
 * Render loop - runs at exactly fb->fps using GStreamer clock
 * This is the heart of the frame synchronizer
 */
static gpointer render_loop(gpointer data) {
    FrameBuffer *fb = (FrameBuffer *)data;

    // Compute frame duration from configured fps
    GstClockTime frame_duration = gst_util_uint64_scale_int(GST_SECOND, 1, fb->fps);

    g_print("[FrameBuffer] Render loop started (%d fps, frame=%"G_GUINT64_FORMAT"ns)\n",
            fb->fps, frame_duration);

    GstClock *clock = gst_pipeline_get_clock(GST_PIPELINE(fb->output_pipeline));
    if (!clock) {
        g_printerr("[FrameBuffer] Failed to get pipeline clock\n");
        return NULL;
    }

    // Use element base-time for proper scheduling
    GstClockTime base_time = gst_element_get_base_time(
        GST_ELEMENT(fb->output_pipeline));

    guint64 frame_count = 0;

    while (fb->running) {
        GstBuffer *buffer_to_push = NULL;
        gboolean is_repeat = FALSE;
        guint64 current_seq = 0;

        // Get current frame (or create fallback)
        g_mutex_lock(&fb->frame_mutex);

        if (fb->current_frame) {
            buffer_to_push = gst_buffer_copy(fb->current_frame);
            current_seq = fb->in_seq;
        } else {
            buffer_to_push = create_fallback_frame(fb);
            is_repeat = TRUE;
        }

        g_mutex_unlock(&fb->frame_mutex);

        // Detect actual frame repeat (same input frame pushed multiple times)
        if (!is_repeat && current_seq == fb->last_pushed_seq) {
            is_repeat = TRUE;  // Same frame as last time
        }
        fb->last_pushed_seq = current_seq;

        // Set timestamps - render loop imposes proper timing
        GstClockTime pts = frame_count * frame_duration;
        GST_BUFFER_PTS(buffer_to_push) = pts;
        GST_BUFFER_DTS(buffer_to_push) = pts;
        GST_BUFFER_DURATION(buffer_to_push) = frame_duration;

        // Push to output
        GstFlowReturn ret = gst_app_src_push_buffer(
            GST_APP_SRC(fb->appsrc), buffer_to_push);

        if (ret != GST_FLOW_OK) {
            g_printerr("[FrameBuffer] Push error: %d\n", ret);
        }

        fb->frames_out++;
        if (is_repeat) fb->frames_repeated++;
        frame_count++;

        // Stats every 5 seconds
        if ((frame_count % (fb->fps * 5)) == 0) {
            g_print("[FrameBuffer] Stats: in=%" G_GUINT64_FORMAT
                    " out=%" G_GUINT64_FORMAT
                    " repeated=%" G_GUINT64_FORMAT "\n",
                    fb->frames_in, fb->frames_out, fb->frames_repeated);
        }

        // Wait until next frame time using GstClockID (proper GStreamer timing)
        GstClockTime running_time = frame_count * frame_duration;
        GstClockTime target_time = base_time + running_time;
        GstClockID clk_id = gst_clock_new_single_shot_id(clock, target_time);
        gst_clock_id_wait(clk_id, NULL);
        gst_clock_id_unref(clk_id);
    }

    gst_object_unref(clock);

    g_print("[FrameBuffer] Render loop stopped\n");
    return NULL;
}

/**
 * Idle callback to start pipelines after main loop is running
 */
static gboolean start_pipelines_idle(gpointer data) {
    FrameBuffer *fb = (FrameBuffer *)data;

    g_print("[FrameBuffer] Starting pipelines...\n");

    // Start output pipeline first
    gst_element_set_state(fb->output_pipeline, GST_STATE_PLAYING);

    // Start render loop
    fb->running = TRUE;
    fb->render_thread = g_thread_new("render-loop", render_loop, fb);

    // Start input pipeline
    gst_element_set_state(fb->input_pipeline, GST_STATE_PLAYING);

    g_print("[FrameBuffer] Running\n");
    g_print("[FrameBuffer] Input:  UDP port %d\n", fb->input_port);
    g_print("[FrameBuffer] Output: %s:%d @ %dfps\n",
            fb->output_host, fb->output_port, fb->fps);

    return G_SOURCE_REMOVE;  // Don't call again
}

/**
 * Start the frame buffer - schedules pipeline start via main loop
 */
static gboolean framebuffer_start(FrameBuffer *fb) {
    g_print("[FrameBuffer] Scheduling startup...\n");

    // Schedule pipeline start to run after main loop starts
    // This ensures dynamic pad callbacks can be processed
    g_idle_add(start_pipelines_idle, fb);

    return TRUE;
}

/**
 * Stop the frame buffer
 */
static void framebuffer_stop(FrameBuffer *fb) {
    g_print("[FrameBuffer] Stopping...\n");

    fb->running = FALSE;

    if (fb->render_thread) {
        g_thread_join(fb->render_thread);
        fb->render_thread = NULL;
    }

    gst_element_set_state(fb->input_pipeline, GST_STATE_NULL);
    gst_element_set_state(fb->output_pipeline, GST_STATE_NULL);

    g_print("[FrameBuffer] Stopped\n");
}

/**
 * Cleanup
 */
static void framebuffer_free(FrameBuffer *fb) {
    if (fb->current_frame) gst_buffer_unref(fb->current_frame);
    if (fb->current_caps) gst_caps_unref(fb->current_caps);
    // Pipeline unrefs take care of child elements (appsink, appsrc)
    if (fb->input_pipeline) gst_object_unref(fb->input_pipeline);
    if (fb->output_pipeline) gst_object_unref(fb->output_pipeline);
    g_free(fb->output_host);
    g_free(fb->shm_path);
    g_mutex_clear(&fb->frame_mutex);
    g_free(fb);
}

/**
 * Signal handler for clean shutdown
 */
static FrameBuffer *g_fb = NULL;

static void signal_handler(int sig) {
    g_print("\n[FrameBuffer] Signal %d received, shutting down...\n", sig);
    if (g_fb && g_fb->loop) {
        g_main_loop_quit(g_fb->loop);
    }
}

/**
 * Print usage
 */
static void print_usage(const char *prog) {
    g_print("Usage: %s [options]\n", prog);
    g_print("Options:\n");
    g_print("  -i PORT   Input UDP port (default: 5001)\n");
    g_print("  -o PORT   Output UDP port (default: 5002)\n");
    g_print("  -H HOST   Output host (default: 127.0.0.1)\n");
    g_print("  -w WIDTH  Output width (default: 640)\n");
    g_print("  -h HEIGHT Output height (default: 480)\n");
    g_print("  -f FPS    Output framerate (default: 25)\n");
    g_print("  -b KBPS   Output bitrate in kbps (default: 2000)\n");
    g_print("  -r        Raw RTP output (no encoding)\n");
    g_print("  -v        VP8 RTP output (WebRTC-ready)\n");
    g_print("  -s [PATH] SHM output for webrtc-gateway (default: /tmp/framebuffer.sock)\n");
}

/**
 * Main
 */
int main(int argc, char *argv[]) {
    gst_init(&argc, &argv);

    FrameBuffer *fb = framebuffer_new();
    g_fb = fb;

    // Parse arguments
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-i") == 0 && i + 1 < argc) {
            fb->input_port = atoi(argv[++i]);
        } else if (strcmp(argv[i], "-o") == 0 && i + 1 < argc) {
            fb->output_port = atoi(argv[++i]);
        } else if (strcmp(argv[i], "-H") == 0 && i + 1 < argc) {
            g_free(fb->output_host);
            fb->output_host = g_strdup(argv[++i]);
        } else if (strcmp(argv[i], "-w") == 0 && i + 1 < argc) {
            fb->width = atoi(argv[++i]);
        } else if (strcmp(argv[i], "-h") == 0 && i + 1 < argc) {
            fb->height = atoi(argv[++i]);
        } else if (strcmp(argv[i], "-f") == 0 && i + 1 < argc) {
            fb->fps = atoi(argv[++i]);
        } else if (strcmp(argv[i], "-b") == 0 && i + 1 < argc) {
            fb->bitrate = atoi(argv[++i]);
        } else if (strcmp(argv[i], "-r") == 0) {
            fb->raw_output = TRUE;
        } else if (strcmp(argv[i], "-v") == 0) {
            fb->vp8_output = TRUE;
        } else if (strcmp(argv[i], "-s") == 0) {
            fb->shm_output = TRUE;
            // Optional path argument
            if (i + 1 < argc && argv[i + 1][0] != '-') {
                g_free(fb->shm_path);
                fb->shm_path = g_strdup(argv[++i]);
            }
        } else if (strcmp(argv[i], "--help") == 0) {
            print_usage(argv[0]);
            return 0;
        }
    }

    g_print("========================================\n");
    g_print("FrameBuffer v1.0 - Video Frame Synchronizer\n");
    g_print("========================================\n");

    // Setup signal handlers
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    // Create pipelines
    if (!create_input_pipeline(fb)) {
        g_printerr("Failed to create input pipeline\n");
        return 1;
    }

    if (!create_output_pipeline(fb)) {
        g_printerr("Failed to create output pipeline\n");
        return 1;
    }

    // Create main loop first - needed for dynamic pad callbacks
    fb->loop = g_main_loop_new(NULL, FALSE);

    // Schedule startup (will run when main loop starts)
    if (!framebuffer_start(fb)) {
        g_printerr("Failed to schedule frame buffer start\n");
        return 1;
    }

    // Run main loop - pipelines start via idle callback
    g_main_loop_run(fb->loop);

    // Cleanup
    framebuffer_stop(fb);
    g_main_loop_unref(fb->loop);
    framebuffer_free(fb);

    return 0;
}
