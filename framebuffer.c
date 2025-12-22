/**
 * SoftwareFrameBuffer - Ultra-stable video frame synchronizer
 *
 * Concept: Decoupled input/output with render loop
 * - Input: Receives frames whenever they arrive (chaotic)
 * - Buffer: Stores the last good frame
 * - Output: Renders at exact fps (rock-solid)
 *
 * Like a camera filming a cinema screen - output is always stable.
 *
 * Author: Stephane Bhiri
 * License: MIT
 */

#include <gst/gst.h>
#include <gst/app/gstappsink.h>
#include <gst/app/gstappsrc.h>
#include <stdio.h>
#include <string.h>
#include <getopt.h>

/* ========== Version ========== */
#define VERSION "1.0.0"

/* ========== Default Configuration ========== */

/* Input defaults */
#define DEFAULT_INPUT_PORT          5001
#define DEFAULT_UDP_BUFFER_SIZE     67108864    /* 64 MB socket buffer */
#define DEFAULT_JITTER_BUFFER_MS    1000        /* 1 second jitter buffer */
#define DEFAULT_MAX_QUEUE_TIME_MS   5000        /* 5 seconds max queue */

/* Output defaults */
#define DEFAULT_OUTPUT_PORT         5002
#define DEFAULT_OUTPUT_HOST         "127.0.0.1"
#define DEFAULT_WIDTH               640
#define DEFAULT_HEIGHT              480
#define DEFAULT_FPS                 25
#define DEFAULT_BITRATE_KBPS        2000
#define DEFAULT_KEYFRAME_INTERVAL   30          /* GOP size */

/* Shared memory defaults */
#define DEFAULT_SHM_PATH            "/tmp/framebuffer.sock"
#define DEFAULT_SHM_SIZE            20000000    /* 20 MB shared memory */

/* Appsink/Appsrc defaults */
#define DEFAULT_APPSINK_MAX_BUFFERS 2
#define DEFAULT_STATS_INTERVAL_SEC  5

/* VP8 encoder defaults */
#define DEFAULT_VP8_DEADLINE        1           /* Real-time */
#define DEFAULT_VP8_CPU_USED        4           /* Speed vs quality */

/* x264 encoder defaults */
#define DEFAULT_X264_TUNE           "zerolatency"
#define DEFAULT_X264_PRESET         "ultrafast"

/* ========== Data Structures ========== */

typedef struct {
    /* Pipelines */
    GstElement *input_pipeline;
    GstElement *output_pipeline;

    /* Key elements */
    GstElement *appsink;      /* Receives decoded frames */
    GstElement *appsrc;       /* Pushes frames at fixed rate */

    /* Frame buffer (single frame, mutex protected) */
    GstBuffer *current_frame;
    GstCaps *current_caps;
    GMutex frame_mutex;

    /* Render loop */
    GThread *render_thread;
    gboolean running;

    /* Stats */
    guint64 frames_in;
    guint64 frames_out;
    guint64 frames_repeated;
    guint64 in_seq;           /* Incremented each new frame received */
    guint64 last_pushed_seq;  /* Last sequence number pushed to output */

    /* Input config */
    gint input_port;
    guint64 udp_buffer_size;
    guint64 jitter_buffer_ms;
    guint64 max_queue_time_ms;

    /* Output config */
    gint output_port;
    gchar *output_host;
    gint width;
    gint height;
    gint fps;
    gint bitrate;
    gint keyframe_interval;

    /* Output mode */
    gboolean raw_output;      /* Output raw video instead of H.264 MPEG-TS */
    gboolean vp8_output;      /* Output VP8 RTP (for direct WebRTC) */
    gboolean shm_output;      /* Output to shared memory for WebRTC Gateway */

    /* Shared memory config */
    gchar *shm_path;
    guint64 shm_size;

    /* Appsink config */
    gint appsink_max_buffers;

    /* Stats config */
    gint stats_interval;

    /* Verbose output */
    gboolean verbose;

    GMainLoop *loop;
} FrameBuffer;

/* ========== Forward Declarations ========== */
static GstFlowReturn on_new_sample(GstElement *sink, FrameBuffer *fb);
static gpointer render_loop(gpointer data);
static GstBuffer *create_fallback_frame(FrameBuffer *fb);
static void on_bus_error(GstBus *bus, GstMessage *msg, gpointer data);

/* ========== Bus Error Handler ========== */
static void on_bus_error(GstBus *bus, GstMessage *msg, gpointer data) {
    (void)bus;
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

/* ========== Initialize FrameBuffer with Defaults ========== */
static FrameBuffer *framebuffer_new(void) {
    FrameBuffer *fb = g_new0(FrameBuffer, 1);
    g_mutex_init(&fb->frame_mutex);
    fb->running = FALSE;
    fb->current_frame = NULL;
    fb->current_caps = NULL;

    /* Input defaults */
    fb->input_port = DEFAULT_INPUT_PORT;
    fb->udp_buffer_size = DEFAULT_UDP_BUFFER_SIZE;
    fb->jitter_buffer_ms = DEFAULT_JITTER_BUFFER_MS;
    fb->max_queue_time_ms = DEFAULT_MAX_QUEUE_TIME_MS;

    /* Output defaults */
    fb->output_port = DEFAULT_OUTPUT_PORT;
    fb->output_host = g_strdup(DEFAULT_OUTPUT_HOST);
    fb->width = DEFAULT_WIDTH;
    fb->height = DEFAULT_HEIGHT;
    fb->fps = DEFAULT_FPS;
    fb->bitrate = DEFAULT_BITRATE_KBPS;
    fb->keyframe_interval = DEFAULT_KEYFRAME_INTERVAL;

    /* Output mode */
    fb->raw_output = FALSE;
    fb->vp8_output = FALSE;
    fb->shm_output = FALSE;

    /* Shared memory */
    fb->shm_path = g_strdup(DEFAULT_SHM_PATH);
    fb->shm_size = DEFAULT_SHM_SIZE;

    /* Appsink */
    fb->appsink_max_buffers = DEFAULT_APPSINK_MAX_BUFFERS;

    /* Stats */
    fb->stats_interval = DEFAULT_STATS_INTERVAL_SEC;

    /* Verbose */
    fb->verbose = FALSE;

    return fb;
}

/* ========== Create Input Pipeline ========== */
static gboolean create_input_pipeline(FrameBuffer *fb) {
    GError *error = NULL;

    /* Convert milliseconds to nanoseconds for GStreamer */
    guint64 jitter_ns = fb->jitter_buffer_ms * 1000000ULL;
    guint64 max_time_ns = fb->max_queue_time_ms * 1000000ULL;

    /*
     * Pipeline: UDP -> Jitter Buffer -> Demux -> Decode -> Normalize -> AppSink
     *
     * Key elements:
     * - udpsrc: Receives UDP packets with large socket buffer
     * - queue with min-threshold-time: JITTER BUFFER - waits before playing
     * - tsparse: Parses MPEG-TS packets
     * - decodebin3: Auto-selects decoder (H.264, MPEG-2, etc.)
     * - videoconvert/videoscale: Normalizes to I420 at target resolution
     * - appsink: Captures decoded frames
     */
    gchar *pipeline_str = g_strdup_printf(
        "udpsrc port=%d buffer-size=%" G_GUINT64_FORMAT " "
        "caps=\"video/mpegts,systemstream=true\" name=udpsrc "
        "! queue min-threshold-time=%" G_GUINT64_FORMAT " "
        "max-size-buffers=0 max-size-bytes=0 max-size-time=%" G_GUINT64_FORMAT " "
        "! tsparse "
        "! decodebin3 "
        "! videoconvert "
        "! videoscale "
        "! video/x-raw,format=I420,width=%d,height=%d "
        "! appsink name=sink emit-signals=true sync=false max-buffers=%d drop=true",
        fb->input_port,
        fb->udp_buffer_size,
        jitter_ns,
        max_time_ns,
        fb->width,
        fb->height,
        fb->appsink_max_buffers
    );

    if (fb->verbose) {
        g_print("[FrameBuffer] Input pipeline: %s\n", pipeline_str);
    }

    fb->input_pipeline = gst_parse_launch(pipeline_str, &error);
    g_free(pipeline_str);

    if (error) {
        g_printerr("[FrameBuffer] Failed to create input pipeline: %s\n", error->message);
        g_error_free(error);
        return FALSE;
    }

    /* Get appsink */
    fb->appsink = gst_bin_get_by_name(GST_BIN(fb->input_pipeline), "sink");
    if (!fb->appsink) {
        g_printerr("[FrameBuffer] Failed to get appsink\n");
        return FALSE;
    }

    /* Connect appsink signal */
    g_signal_connect(fb->appsink, "new-sample", G_CALLBACK(on_new_sample), fb);

    /* Add bus watch for errors */
    GstBus *bus = gst_pipeline_get_bus(GST_PIPELINE(fb->input_pipeline));
    gst_bus_add_signal_watch(bus);
    g_signal_connect(bus, "message::error", G_CALLBACK(on_bus_error), (gpointer)"INPUT");
    gst_object_unref(bus);

    g_print("[FrameBuffer] Input: UDP port %d, %"G_GUINT64_FORMAT"ms jitter buffer\n",
            fb->input_port, fb->jitter_buffer_ms);
    return TRUE;
}

/* ========== Create Output Pipeline ========== */
static gboolean create_output_pipeline(FrameBuffer *fb) {
    gchar *caps_str = g_strdup_printf(
        "video/x-raw,format=I420,width=%d,height=%d,framerate=%d/1",
        fb->width, fb->height, fb->fps
    );

    gchar *pipeline_str;
    const gchar *mode_name;

    if (fb->shm_output) {
        /* Shared Memory output for IPC with WebRTC Gateway */
        pipeline_str = g_strdup_printf(
            "appsrc name=src is-live=true format=time do-timestamp=true "
            "caps=\"%s\" "
            "! shmsink socket-path=%s shm-size=%" G_GUINT64_FORMAT " "
            "wait-for-connection=false sync=false",
            caps_str, fb->shm_path, fb->shm_size
        );
        mode_name = "Shared Memory";
    } else if (fb->vp8_output) {
        /* VP8 RTP output - WebRTC-ready */
        pipeline_str = g_strdup_printf(
            "appsrc name=src is-live=true format=time do-timestamp=true "
            "caps=\"%s\" "
            "! videoconvert "
            "! vp8enc deadline=%d cpu-used=%d target-bitrate=%d000 keyframe-max-dist=%d "
            "! rtpvp8pay mtu=1200 "
            "! udpsink host=%s port=%d sync=false",
            caps_str,
            DEFAULT_VP8_DEADLINE, DEFAULT_VP8_CPU_USED,
            fb->bitrate, fb->keyframe_interval,
            fb->output_host, fb->output_port
        );
        mode_name = "VP8 RTP";
    } else if (fb->raw_output) {
        /* Raw RTP output - no encoding */
        pipeline_str = g_strdup_printf(
            "appsrc name=src is-live=true format=time do-timestamp=true "
            "caps=\"%s\" "
            "! rtpvrawpay mtu=1400 "
            "! udpsink host=%s port=%d sync=false",
            caps_str, fb->output_host, fb->output_port
        );
        mode_name = "Raw RTP";
    } else {
        /* H.264 MPEG-TS output (default) */
        pipeline_str = g_strdup_printf(
            "appsrc name=src is-live=true format=time do-timestamp=false "
            "caps=\"%s\" "
            "! videoconvert "
            "! x264enc tune=%s speed-preset=%s bitrate=%d key-int-max=%d "
            "! h264parse "
            "! mpegtsmux "
            "! udpsink host=%s port=%d sync=false",
            caps_str,
            DEFAULT_X264_TUNE, DEFAULT_X264_PRESET,
            fb->bitrate, fb->keyframe_interval,
            fb->output_host, fb->output_port
        );
        mode_name = "H.264 MPEG-TS";
    }

    g_free(caps_str);

    if (fb->verbose) {
        g_print("[FrameBuffer] Output pipeline: %s\n", pipeline_str);
    }

    GError *error = NULL;
    fb->output_pipeline = gst_parse_launch(pipeline_str, &error);
    g_free(pipeline_str);

    if (error) {
        g_printerr("[FrameBuffer] Output pipeline error: %s\n", error->message);
        g_error_free(error);
        return FALSE;
    }

    /* Get appsrc */
    fb->appsrc = gst_bin_get_by_name(GST_BIN(fb->output_pipeline), "src");

    if (fb->shm_output) {
        g_print("[FrameBuffer] Output: %s @ %s, %dx%d @ %dfps\n",
                mode_name, fb->shm_path, fb->width, fb->height, fb->fps);
    } else {
        g_print("[FrameBuffer] Output: %s @ %s:%d, %dx%d @ %dfps, %dkbps\n",
                mode_name, fb->output_host, fb->output_port,
                fb->width, fb->height, fb->fps, fb->bitrate);
    }

    return TRUE;
}

/* ========== New Sample Callback ========== */
static GstFlowReturn on_new_sample(GstElement *sink, FrameBuffer *fb) {
    GstSample *sample = gst_app_sink_pull_sample(GST_APP_SINK(sink));
    if (!sample) return GST_FLOW_ERROR;

    GstBuffer *buffer = gst_sample_get_buffer(sample);
    GstCaps *caps = gst_sample_get_caps(sample);

    g_mutex_lock(&fb->frame_mutex);

    /* Replace current frame */
    if (fb->current_frame) {
        gst_buffer_unref(fb->current_frame);
    }
    fb->current_frame = gst_buffer_ref(buffer);

    /* Update caps if changed */
    if (caps && (!fb->current_caps || !gst_caps_is_equal(caps, fb->current_caps))) {
        if (fb->current_caps) gst_caps_unref(fb->current_caps);
        fb->current_caps = gst_caps_ref(caps);
    }

    fb->frames_in++;
    fb->in_seq++;

    g_mutex_unlock(&fb->frame_mutex);

    gst_sample_unref(sample);

    return GST_FLOW_OK;
}

/* ========== Create Fallback Frame ========== */
static GstBuffer *create_fallback_frame(FrameBuffer *fb) {
    gsize y_size = fb->width * fb->height;
    gsize uv_size = y_size / 4;
    gsize total_size = y_size + 2 * uv_size;  /* I420 format */

    GstBuffer *buffer = gst_buffer_new_allocate(NULL, total_size, NULL);

    GstMapInfo map;
    gst_buffer_map(buffer, &map, GST_MAP_WRITE);

    /* Y plane: gray (128) */
    memset(map.data, 128, y_size);

    /* U and V planes: neutral (128) */
    memset(map.data + y_size, 128, uv_size);
    memset(map.data + y_size + uv_size, 128, uv_size);

    gst_buffer_unmap(buffer, &map);

    return buffer;
}

/* ========== Render Loop ========== */
static gpointer render_loop(gpointer data) {
    FrameBuffer *fb = (FrameBuffer *)data;

    /* Compute frame duration from configured fps */
    GstClockTime frame_duration = gst_util_uint64_scale_int(GST_SECOND, 1, fb->fps);

    g_print("[FrameBuffer] Render loop started (%d fps, frame=%" G_GUINT64_FORMAT "ns)\n",
            fb->fps, frame_duration);

    GstClock *clock = gst_pipeline_get_clock(GST_PIPELINE(fb->output_pipeline));
    if (!clock) {
        g_printerr("[FrameBuffer] Failed to get pipeline clock\n");
        return NULL;
    }

    GstClockTime base_time = gst_element_get_base_time(GST_ELEMENT(fb->output_pipeline));
    guint64 frame_count = 0;
    guint64 stats_frames = fb->fps * fb->stats_interval;

    while (fb->running) {
        GstBuffer *buffer_to_push = NULL;
        gboolean is_repeat = FALSE;
        guint64 current_seq = 0;

        /* Get current frame (or create fallback) */
        g_mutex_lock(&fb->frame_mutex);

        if (fb->current_frame) {
            buffer_to_push = gst_buffer_copy(fb->current_frame);
            current_seq = fb->in_seq;
        } else {
            buffer_to_push = create_fallback_frame(fb);
            is_repeat = TRUE;
        }

        g_mutex_unlock(&fb->frame_mutex);

        /* Detect frame repeat */
        if (!is_repeat && current_seq == fb->last_pushed_seq) {
            is_repeat = TRUE;
        }
        fb->last_pushed_seq = current_seq;

        /* Set timestamps */
        GstClockTime pts = frame_count * frame_duration;
        GST_BUFFER_PTS(buffer_to_push) = pts;
        GST_BUFFER_DTS(buffer_to_push) = pts;
        GST_BUFFER_DURATION(buffer_to_push) = frame_duration;

        /* Push to output */
        GstFlowReturn ret = gst_app_src_push_buffer(
            GST_APP_SRC(fb->appsrc), buffer_to_push);

        if (ret != GST_FLOW_OK) {
            g_printerr("[FrameBuffer] Push error: %d\n", ret);
        }

        fb->frames_out++;
        if (is_repeat) fb->frames_repeated++;
        frame_count++;

        /* Stats */
        if (stats_frames > 0 && (frame_count % stats_frames) == 0) {
            g_print("[FrameBuffer] Stats: in=%" G_GUINT64_FORMAT
                    " out=%" G_GUINT64_FORMAT
                    " repeated=%" G_GUINT64_FORMAT "\n",
                    fb->frames_in, fb->frames_out, fb->frames_repeated);
        }

        /* Wait until next frame time */
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

/* ========== Pipeline Start (Idle Callback) ========== */
static gboolean start_pipelines_idle(gpointer data) {
    FrameBuffer *fb = (FrameBuffer *)data;

    g_print("[FrameBuffer] Starting pipelines...\n");

    /* Start output pipeline first */
    gst_element_set_state(fb->output_pipeline, GST_STATE_PLAYING);

    /* Start render loop */
    fb->running = TRUE;
    fb->render_thread = g_thread_new("render-loop", render_loop, fb);

    /* Start input pipeline */
    gst_element_set_state(fb->input_pipeline, GST_STATE_PLAYING);

    g_print("[FrameBuffer] Running\n");

    return G_SOURCE_REMOVE;
}

/* ========== Start ========== */
static gboolean framebuffer_start(FrameBuffer *fb) {
    g_print("[FrameBuffer] Scheduling startup...\n");
    g_idle_add(start_pipelines_idle, fb);
    return TRUE;
}

/* ========== Stop ========== */
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

/* ========== Cleanup ========== */
static void framebuffer_free(FrameBuffer *fb) {
    if (fb->current_frame) gst_buffer_unref(fb->current_frame);
    if (fb->current_caps) gst_caps_unref(fb->current_caps);
    if (fb->input_pipeline) gst_object_unref(fb->input_pipeline);
    if (fb->output_pipeline) gst_object_unref(fb->output_pipeline);
    g_free(fb->output_host);
    g_free(fb->shm_path);
    g_mutex_clear(&fb->frame_mutex);
    g_free(fb);
}

/* ========== Signal Handler ========== */
static FrameBuffer *g_fb = NULL;

static void signal_handler(int sig) {
    g_print("\n[FrameBuffer] Signal %d received, shutting down...\n", sig);
    if (g_fb && g_fb->loop) {
        g_main_loop_quit(g_fb->loop);
    }
}

/* ========== Help / Usage ========== */
static void print_usage(const char *prog) {
    g_print("SoftwareFrameBuffer v%s - Ultra-stable video frame synchronizer\n\n", VERSION);
    g_print("Usage: %s [options]\n\n", prog);

    g_print("INPUT OPTIONS:\n");
    g_print("  -i, --input-port PORT      UDP input port (default: %d)\n", DEFAULT_INPUT_PORT);
    g_print("  -B, --udp-buffer SIZE      UDP socket buffer in bytes (default: %d)\n", DEFAULT_UDP_BUFFER_SIZE);
    g_print("  -j, --jitter-buffer MS     Jitter buffer in milliseconds (default: %d)\n", DEFAULT_JITTER_BUFFER_MS);
    g_print("  -Q, --max-queue MS         Max queue time in milliseconds (default: %d)\n", DEFAULT_MAX_QUEUE_TIME_MS);
    g_print("\n");

    g_print("OUTPUT OPTIONS:\n");
    g_print("  -o, --output-port PORT     UDP output port (default: %d)\n", DEFAULT_OUTPUT_PORT);
    g_print("  -H, --host HOST            Output host/IP (default: %s)\n", DEFAULT_OUTPUT_HOST);
    g_print("  -w, --width WIDTH          Output width (default: %d)\n", DEFAULT_WIDTH);
    g_print("  -h, --height HEIGHT        Output height (default: %d)\n", DEFAULT_HEIGHT);
    g_print("  -f, --fps FPS              Output framerate (default: %d)\n", DEFAULT_FPS);
    g_print("  -b, --bitrate KBPS         Encoder bitrate in kbps (default: %d)\n", DEFAULT_BITRATE_KBPS);
    g_print("  -k, --keyframe INT         Keyframe interval / GOP size (default: %d)\n", DEFAULT_KEYFRAME_INTERVAL);
    g_print("\n");

    g_print("OUTPUT MODES (mutually exclusive):\n");
    g_print("  (default)                  H.264 MPEG-TS over UDP\n");
    g_print("  -r, --raw                  Raw RTP video (no encoding)\n");
    g_print("  -v, --vp8                  VP8 RTP (WebRTC-ready)\n");
    g_print("  -s, --shm [PATH]           Shared memory output (default: %s)\n", DEFAULT_SHM_PATH);
    g_print("      --shm-size SIZE        Shared memory size in bytes (default: %d)\n", DEFAULT_SHM_SIZE);
    g_print("\n");

    g_print("OTHER OPTIONS:\n");
    g_print("  -S, --stats-interval SEC   Stats print interval, 0=off (default: %d)\n", DEFAULT_STATS_INTERVAL_SEC);
    g_print("  -V, --verbose              Verbose output (show pipeline strings)\n");
    g_print("      --help                 Show this help\n");
    g_print("      --version              Show version\n");
    g_print("\n");

    g_print("EXAMPLES:\n");
    g_print("  %s -i 5000 -w 1280 -h 720 -f 30\n", prog);
    g_print("  %s -i 5000 -s /tmp/fb.sock -w 640 -h 480 -f 30\n", prog);
    g_print("  %s -i 5000 -v -o 5004 -b 3000\n", prog);
    g_print("  %s -i 5000 -j 2000 --verbose\n", prog);
}

static void print_version(void) {
    g_print("SoftwareFrameBuffer v%s\n", VERSION);
}

/* ========== Main ========== */
int main(int argc, char *argv[]) {
    gst_init(&argc, &argv);

    FrameBuffer *fb = framebuffer_new();
    g_fb = fb;

    /* Long options */
    static struct option long_options[] = {
        {"input-port",    required_argument, 0, 'i'},
        {"udp-buffer",    required_argument, 0, 'B'},
        {"jitter-buffer", required_argument, 0, 'j'},
        {"max-queue",     required_argument, 0, 'Q'},
        {"output-port",   required_argument, 0, 'o'},
        {"host",          required_argument, 0, 'H'},
        {"width",         required_argument, 0, 'w'},
        {"height",        required_argument, 0, 'h'},
        {"fps",           required_argument, 0, 'f'},
        {"bitrate",       required_argument, 0, 'b'},
        {"keyframe",      required_argument, 0, 'k'},
        {"raw",           no_argument,       0, 'r'},
        {"vp8",           no_argument,       0, 'v'},
        {"shm",           optional_argument, 0, 's'},
        {"shm-size",      required_argument, 0, 'Z'},
        {"stats-interval",required_argument, 0, 'S'},
        {"verbose",       no_argument,       0, 'V'},
        {"help",          no_argument,       0, '?'},
        {"version",       no_argument,       0, 'E'},
        {0, 0, 0, 0}
    };

    int opt;
    int option_index = 0;

    while ((opt = getopt_long(argc, argv, "i:B:j:Q:o:H:w:h:f:b:k:rvs::Z:S:V",
                              long_options, &option_index)) != -1) {
        switch (opt) {
            case 'i':
                fb->input_port = atoi(optarg);
                break;
            case 'B':
                fb->udp_buffer_size = strtoull(optarg, NULL, 10);
                break;
            case 'j':
                fb->jitter_buffer_ms = strtoull(optarg, NULL, 10);
                break;
            case 'Q':
                fb->max_queue_time_ms = strtoull(optarg, NULL, 10);
                break;
            case 'o':
                fb->output_port = atoi(optarg);
                break;
            case 'H':
                g_free(fb->output_host);
                fb->output_host = g_strdup(optarg);
                break;
            case 'w':
                fb->width = atoi(optarg);
                break;
            case 'h':
                fb->height = atoi(optarg);
                break;
            case 'f':
                fb->fps = atoi(optarg);
                break;
            case 'b':
                fb->bitrate = atoi(optarg);
                break;
            case 'k':
                fb->keyframe_interval = atoi(optarg);
                break;
            case 'r':
                fb->raw_output = TRUE;
                break;
            case 'v':
                fb->vp8_output = TRUE;
                break;
            case 's':
                fb->shm_output = TRUE;
                if (optarg) {
                    g_free(fb->shm_path);
                    fb->shm_path = g_strdup(optarg);
                }
                break;
            case 'Z':
                fb->shm_size = strtoull(optarg, NULL, 10);
                break;
            case 'S':
                fb->stats_interval = atoi(optarg);
                break;
            case 'V':
                fb->verbose = TRUE;
                break;
            case 'E':
                print_version();
                return 0;
            case '?':
            default:
                print_usage(argv[0]);
                return (opt == '?') ? 0 : 1;
        }
    }

    g_print("========================================\n");
    g_print("SoftwareFrameBuffer v%s\n", VERSION);
    g_print("========================================\n");

    /* Setup signal handlers */
    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    /* Create pipelines */
    if (!create_input_pipeline(fb)) {
        g_printerr("Failed to create input pipeline\n");
        return 1;
    }

    if (!create_output_pipeline(fb)) {
        g_printerr("Failed to create output pipeline\n");
        return 1;
    }

    /* Create main loop */
    fb->loop = g_main_loop_new(NULL, FALSE);

    /* Schedule startup */
    if (!framebuffer_start(fb)) {
        g_printerr("Failed to schedule frame buffer start\n");
        return 1;
    }

    /* Run main loop */
    g_main_loop_run(fb->loop);

    /* Cleanup */
    framebuffer_stop(fb);
    g_main_loop_unref(fb->loop);
    framebuffer_free(fb);

    return 0;
}
