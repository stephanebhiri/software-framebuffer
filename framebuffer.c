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
#define VERSION "1.1.0"

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

/* Encoder defaults */
#define DEFAULT_X264_TUNE           "zerolatency"
#define DEFAULT_X264_PRESET         "ultrafast"
#define DEFAULT_X265_TUNE           "zerolatency"
#define DEFAULT_X265_PRESET         "ultrafast"
#define DEFAULT_VP8_DEADLINE        1           /* Real-time */
#define DEFAULT_VP8_CPU_USED        4           /* Speed vs quality */
#define DEFAULT_VP9_DEADLINE        1
#define DEFAULT_VP9_CPU_USED        4

/* RTP defaults */
#define DEFAULT_RTP_MTU             1200
#define DEFAULT_NO_SIGNAL_TIMEOUT   5000000000  /* 5 seconds in nanoseconds */

/* ========== Enums ========== */

typedef enum {
    CODEC_RAW,      /* No encoding */
    CODEC_H264,     /* x264enc */
    CODEC_H265,     /* x265enc */
    CODEC_VP8,      /* vp8enc */
    CODEC_VP9       /* vp9enc */
} OutputCodec;

typedef enum {
    CONTAINER_RTP,      /* RTP payload over UDP */
    CONTAINER_MPEGTS,   /* MPEG-TS over UDP */
    CONTAINER_SHM,      /* Shared memory (raw frames) */
    CONTAINER_RAW_UDP,  /* Raw bitstream over UDP (no container) */
    CONTAINER_FILE      /* File output (mp4, mkv, ts) */
} OutputContainer;

/* ========== Data Structures ========== */

typedef struct {
    /* Pipelines */
    GstElement *input_pipeline;
    GstElement *output_pipeline;

    /* Key elements */
    GstElement *appsink;
    GstElement *appsrc;

    /* Frame buffer (single frame, mutex protected) */
    GstBuffer *current_frame;
    GstCaps *current_caps;
    GstBuffer *fallback_frame;    /* Pre-allocated grey frame (avoid memory churn) */
    GstClockTime last_input_time; /* For no-signal timeout detection */
    GMutex frame_mutex;

    /* Render loop */
    GThread *render_thread;
    gboolean running;

    /* Stats */
    guint64 frames_in;
    guint64 frames_out;
    guint64 frames_repeated;
    guint64 in_seq;
    guint64 last_pushed_seq;

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

    /* Output format */
    OutputCodec codec;
    OutputContainer container;

    /* Shared memory config */
    gchar *shm_path;
    guint64 shm_size;

    /* File output config */
    gchar *output_file;

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

/* ========== Helper Functions ========== */

static const char *codec_to_string(OutputCodec codec) {
    switch (codec) {
        case CODEC_RAW:  return "raw";
        case CODEC_H264: return "h264";
        case CODEC_H265: return "h265";
        case CODEC_VP8:  return "vp8";
        case CODEC_VP9:  return "vp9";
        default:         return "unknown";
    }
}

static const char *container_to_string(OutputContainer container) {
    switch (container) {
        case CONTAINER_RTP:     return "rtp";
        case CONTAINER_MPEGTS:  return "mpegts";
        case CONTAINER_SHM:     return "shm";
        case CONTAINER_RAW_UDP: return "raw";
        case CONTAINER_FILE:    return "file";
        default:                return "unknown";
    }
}

static OutputCodec string_to_codec(const char *str) {
    if (strcasecmp(str, "raw") == 0 || strcasecmp(str, "none") == 0) return CODEC_RAW;
    if (strcasecmp(str, "h264") == 0 || strcasecmp(str, "avc") == 0) return CODEC_H264;
    if (strcasecmp(str, "h265") == 0 || strcasecmp(str, "hevc") == 0) return CODEC_H265;
    if (strcasecmp(str, "vp8") == 0) return CODEC_VP8;
    if (strcasecmp(str, "vp9") == 0) return CODEC_VP9;
    return CODEC_H264;  /* Default */
}

static OutputContainer string_to_container(const char *str) {
    if (strcasecmp(str, "rtp") == 0) return CONTAINER_RTP;
    if (strcasecmp(str, "mpegts") == 0 || strcasecmp(str, "ts") == 0) return CONTAINER_MPEGTS;
    if (strcasecmp(str, "shm") == 0 || strcasecmp(str, "shmem") == 0) return CONTAINER_SHM;
    if (strcasecmp(str, "raw") == 0 || strcasecmp(str, "none") == 0) return CONTAINER_RAW_UDP;
    if (strcasecmp(str, "file") == 0 || strcasecmp(str, "mp4") == 0 ||
        strcasecmp(str, "mkv") == 0 || strcasecmp(str, "avi") == 0) return CONTAINER_FILE;
    return CONTAINER_RTP;  /* Default */
}

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
    fb->fallback_frame = NULL;      /* Created after we know dimensions */
    fb->last_input_time = 0;        /* No input yet */

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

    /* Output format defaults */
    fb->codec = CODEC_H264;
    fb->container = CONTAINER_MPEGTS;

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

    guint64 jitter_ns = fb->jitter_buffer_ms * 1000000ULL;
    guint64 max_time_ns = fb->max_queue_time_ms * 1000000ULL;

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

    fb->appsink = gst_bin_get_by_name(GST_BIN(fb->input_pipeline), "sink");
    if (!fb->appsink) {
        g_printerr("[FrameBuffer] Failed to get appsink\n");
        return FALSE;
    }

    g_signal_connect(fb->appsink, "new-sample", G_CALLBACK(on_new_sample), fb);

    GstBus *bus = gst_pipeline_get_bus(GST_PIPELINE(fb->input_pipeline));
    gst_bus_add_signal_watch(bus);
    g_signal_connect(bus, "message::error", G_CALLBACK(on_bus_error), (gpointer)"INPUT");
    gst_object_unref(bus);

    g_print("[FrameBuffer] Input: UDP port %d, %" G_GUINT64_FORMAT "ms jitter buffer\n",
            fb->input_port, fb->jitter_buffer_ms);
    return TRUE;
}

/* ========== Build Encoder String ========== */
static gchar *build_encoder_string(FrameBuffer *fb) {
    switch (fb->codec) {
        case CODEC_RAW:
            return g_strdup("");  /* No encoder */

        case CODEC_H264:
            return g_strdup_printf(
                "videoconvert ! x264enc tune=%s speed-preset=%s bitrate=%d key-int-max=%d ! h264parse ",
                DEFAULT_X264_TUNE, DEFAULT_X264_PRESET,
                fb->bitrate, fb->keyframe_interval
            );

        case CODEC_H265:
            return g_strdup_printf(
                "videoconvert ! x265enc tune=%s speed-preset=%s bitrate=%d key-int-max=%d ! h265parse ",
                DEFAULT_X265_TUNE, DEFAULT_X265_PRESET,
                fb->bitrate, fb->keyframe_interval
            );

        case CODEC_VP8:
            return g_strdup_printf(
                "videoconvert ! vp8enc deadline=%d cpu-used=%d target-bitrate=%d000 keyframe-max-dist=%d ",
                DEFAULT_VP8_DEADLINE, DEFAULT_VP8_CPU_USED,
                fb->bitrate, fb->keyframe_interval
            );

        case CODEC_VP9:
            return g_strdup_printf(
                "videoconvert ! vp9enc deadline=%d cpu-used=%d target-bitrate=%d000 keyframe-max-dist=%d ",
                DEFAULT_VP9_DEADLINE, DEFAULT_VP9_CPU_USED,
                fb->bitrate, fb->keyframe_interval
            );

        default:
            return g_strdup("");
    }
}

/* ========== Build Muxer/Payloader String ========== */
/* NOTE: All strings start with "! " to properly link after encoder */
static gchar *build_muxer_string(FrameBuffer *fb) {
    switch (fb->container) {
        case CONTAINER_SHM:
            return g_strdup_printf(
                "! shmsink socket-path=%s shm-size=%" G_GUINT64_FORMAT " wait-for-connection=false sync=false",
                fb->shm_path, fb->shm_size
            );

        case CONTAINER_MPEGTS:
            return g_strdup_printf(
                "! mpegtsmux ! udpsink host=%s port=%d sync=false",
                fb->output_host, fb->output_port
            );

        case CONTAINER_RAW_UDP:
            return g_strdup_printf(
                "! udpsink host=%s port=%d sync=false",
                fb->output_host, fb->output_port
            );

        case CONTAINER_FILE:
            /* File muxer based on codec */
            if (fb->codec == CODEC_RAW) {
                return g_strdup_printf(
                    "! avimux ! filesink location=%s",
                    fb->output_file ? fb->output_file : "output.avi"
                );
            } else if (fb->codec == CODEC_VP8 || fb->codec == CODEC_VP9) {
                return g_strdup_printf(
                    "! matroskamux ! filesink location=%s",
                    fb->output_file ? fb->output_file : "output.mkv"
                );
            } else {
                /* H.264, H.265 -> MP4 */
                return g_strdup_printf(
                    "! mp4mux ! filesink location=%s",
                    fb->output_file ? fb->output_file : "output.mp4"
                );
            }

        case CONTAINER_RTP:
        default:
            /* RTP payloader depends on codec */
            switch (fb->codec) {
                case CODEC_RAW:
                    return g_strdup_printf(
                        "! rtpvrawpay mtu=%d ! udpsink host=%s port=%d sync=false",
                        DEFAULT_RTP_MTU, fb->output_host, fb->output_port
                    );
                case CODEC_H264:
                    return g_strdup_printf(
                        "! rtph264pay config-interval=1 mtu=%d ! udpsink host=%s port=%d sync=false",
                        DEFAULT_RTP_MTU, fb->output_host, fb->output_port
                    );
                case CODEC_H265:
                    return g_strdup_printf(
                        "! rtph265pay config-interval=1 mtu=%d ! udpsink host=%s port=%d sync=false",
                        DEFAULT_RTP_MTU, fb->output_host, fb->output_port
                    );
                case CODEC_VP8:
                    return g_strdup_printf(
                        "! rtpvp8pay mtu=%d ! udpsink host=%s port=%d sync=false",
                        DEFAULT_RTP_MTU, fb->output_host, fb->output_port
                    );
                case CODEC_VP9:
                    return g_strdup_printf(
                        "! rtpvp9pay mtu=%d ! udpsink host=%s port=%d sync=false",
                        DEFAULT_RTP_MTU, fb->output_host, fb->output_port
                    );
                default:
                    return g_strdup_printf(
                        "! udpsink host=%s port=%d sync=false",
                        fb->output_host, fb->output_port
                    );
            }
    }
}

/* ========== Create Output Pipeline ========== */
static gboolean create_output_pipeline(FrameBuffer *fb) {
    gchar *caps_str = g_strdup_printf(
        "video/x-raw,format=I420,width=%d,height=%d,framerate=%d/1",
        fb->width, fb->height, fb->fps
    );

    gchar *encoder_str = build_encoder_string(fb);
    gchar *muxer_str = build_muxer_string(fb);

    /* For SHM output with encoded video, we need different handling */
    gboolean shm_with_encoding = (fb->container == CONTAINER_SHM && fb->codec != CODEC_RAW);

    /*
     * CRITICAL FIX (intern review):
     * Always use do-timestamp=false because render_loop calculates precise PTS.
     * If do-timestamp=true, appsrc would overwrite our carefully calculated timestamps.
     */
    const char *appsrc_props = "appsrc name=src is-live=true format=time do-timestamp=false";

    gchar *pipeline_str;
    if (fb->container == CONTAINER_SHM && fb->codec == CODEC_RAW) {
        /* SHM with raw frames (muxer_str starts with "!") */
        pipeline_str = g_strdup_printf(
            "%s caps=\"%s\" %s",
            appsrc_props, caps_str, muxer_str
        );
    } else if (shm_with_encoding) {
        /* SHM with encoded video */
        pipeline_str = g_strdup_printf(
            "%s caps=\"%s\" ! %s%s",
            appsrc_props, caps_str, encoder_str, muxer_str
        );
    } else if (fb->codec == CODEC_RAW) {
        /* Raw codec (no encoder) - muxer_str starts with "!" */
        pipeline_str = g_strdup_printf(
            "%s caps=\"%s\" %s",
            appsrc_props, caps_str, muxer_str
        );
    } else {
        /* Normal output with encoder */
        pipeline_str = g_strdup_printf(
            "%s caps=\"%s\" ! %s%s",
            appsrc_props, caps_str, encoder_str, muxer_str
        );
    }

    g_free(caps_str);
    g_free(encoder_str);
    g_free(muxer_str);

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

    fb->appsrc = gst_bin_get_by_name(GST_BIN(fb->output_pipeline), "src");

    /* Print output info */
    if (fb->container == CONTAINER_SHM) {
        g_print("[FrameBuffer] Output: %s/%s @ %s, %dx%d @ %dfps\n",
                codec_to_string(fb->codec), container_to_string(fb->container),
                fb->shm_path, fb->width, fb->height, fb->fps);
    } else if (fb->container == CONTAINER_FILE) {
        g_print("[FrameBuffer] Output: %s/%s @ %s, %dx%d @ %dfps",
                codec_to_string(fb->codec), container_to_string(fb->container),
                fb->output_file ? fb->output_file : "output.*",
                fb->width, fb->height, fb->fps);
        if (fb->codec != CODEC_RAW) {
            g_print(", %dkbps", fb->bitrate);
        }
        g_print("\n");
    } else {
        g_print("[FrameBuffer] Output: %s/%s @ %s:%d, %dx%d @ %dfps",
                codec_to_string(fb->codec), container_to_string(fb->container),
                fb->output_host, fb->output_port,
                fb->width, fb->height, fb->fps);
        if (fb->codec != CODEC_RAW) {
            g_print(", %dkbps", fb->bitrate);
        }
        g_print("\n");
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

    if (fb->current_frame) {
        gst_buffer_unref(fb->current_frame);
    }
    fb->current_frame = gst_buffer_ref(buffer);

    if (caps && (!fb->current_caps || !gst_caps_is_equal(caps, fb->current_caps))) {
        if (fb->current_caps) gst_caps_unref(fb->current_caps);
        fb->current_caps = gst_caps_ref(caps);
    }

    fb->frames_in++;
    fb->in_seq++;
    fb->last_input_time = g_get_monotonic_time() * 1000;  /* Record input time (ns) */

    g_mutex_unlock(&fb->frame_mutex);

    gst_sample_unref(sample);

    return GST_FLOW_OK;
}

/* ========== Create Fallback Frame ========== */
static GstBuffer *create_fallback_frame(FrameBuffer *fb) {
    gsize y_size = fb->width * fb->height;
    gsize uv_size = y_size / 4;
    gsize total_size = y_size + 2 * uv_size;

    GstBuffer *buffer = gst_buffer_new_allocate(NULL, total_size, NULL);

    GstMapInfo map;
    gst_buffer_map(buffer, &map, GST_MAP_WRITE);

    memset(map.data, 128, y_size);
    memset(map.data + y_size, 128, uv_size);
    memset(map.data + y_size + uv_size, 128, uv_size);

    gst_buffer_unmap(buffer, &map);

    return buffer;
}

/* ========== Render Loop ========== */
static gpointer render_loop(gpointer data) {
    FrameBuffer *fb = (FrameBuffer *)data;

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
    guint64 stats_frames = (fb->stats_interval > 0) ? fb->fps * fb->stats_interval : 0;
    gboolean signal_lost_logged = FALSE;

    while (fb->running) {
        GstBuffer *buffer_to_push = NULL;
        gboolean is_repeat = FALSE;
        gboolean use_fallback = FALSE;
        guint64 current_seq = 0;

        g_mutex_lock(&fb->frame_mutex);

        /* Check for no-signal timeout: if last input was more than 5 seconds ago */
        GstClockTime now = g_get_monotonic_time() * 1000;  /* ns */
        gboolean signal_timeout = (fb->last_input_time > 0) &&
                                  ((now - fb->last_input_time) > DEFAULT_NO_SIGNAL_TIMEOUT);

        if (fb->current_frame && !signal_timeout) {
            /* Normal case: we have a valid, recent frame */
            buffer_to_push = gst_buffer_copy(fb->current_frame);
            current_seq = fb->in_seq;
            signal_lost_logged = FALSE;
        } else {
            /* No frame or signal timeout: use cached fallback frame */
            use_fallback = TRUE;
            is_repeat = TRUE;
            if (signal_timeout && !signal_lost_logged) {
                g_print("[FrameBuffer] No signal for 5s, switching to fallback frame\n");
                signal_lost_logged = TRUE;
            }
        }

        g_mutex_unlock(&fb->frame_mutex);

        /* Use pre-allocated fallback frame (copy to avoid ownership issues) */
        if (use_fallback) {
            if (fb->fallback_frame) {
                buffer_to_push = gst_buffer_copy(fb->fallback_frame);
            } else {
                /* Fallback not yet created - create one (should not happen normally) */
                buffer_to_push = create_fallback_frame(fb);
            }
        }

        if (!is_repeat && current_seq == fb->last_pushed_seq) {
            is_repeat = TRUE;
        }
        fb->last_pushed_seq = current_seq;

        GstClockTime pts = frame_count * frame_duration;
        GST_BUFFER_PTS(buffer_to_push) = pts;
        GST_BUFFER_DTS(buffer_to_push) = pts;
        GST_BUFFER_DURATION(buffer_to_push) = frame_duration;

        GstFlowReturn ret = gst_app_src_push_buffer(
            GST_APP_SRC(fb->appsrc), buffer_to_push);

        if (ret != GST_FLOW_OK) {
            if (ret == GST_FLOW_FLUSHING || ret == GST_FLOW_EOS) {
                g_print("[FrameBuffer] Output pipeline flushing/EOS, stopping loop\n");
                break;
            }
            g_printerr("[FrameBuffer] Push error: %d\n", ret);
        }

        fb->frames_out++;
        if (is_repeat) fb->frames_repeated++;
        frame_count++;

        if (stats_frames > 0 && (frame_count % stats_frames) == 0) {
            g_print("[FrameBuffer] Stats: in=%" G_GUINT64_FORMAT
                    " out=%" G_GUINT64_FORMAT
                    " repeated=%" G_GUINT64_FORMAT "\n",
                    fb->frames_in, fb->frames_out, fb->frames_repeated);
        }

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

    /* Pre-allocate fallback frame (grey) to avoid memory churn */
    if (!fb->fallback_frame) {
        fb->fallback_frame = create_fallback_frame(fb);
        g_print("[FrameBuffer] Fallback frame pre-allocated\n");
    }

    gst_element_set_state(fb->output_pipeline, GST_STATE_PLAYING);

    fb->running = TRUE;
    fb->render_thread = g_thread_new("render-loop", render_loop, fb);

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
    if (fb->fallback_frame) gst_buffer_unref(fb->fallback_frame);
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

    g_print("OUTPUT FORMAT:\n");
    g_print("  -c, --codec CODEC          Output codec: raw, h264, h265, vp8, vp9 (default: h264)\n");
    g_print("  -C, --container CONT       Container: rtp, mpegts, shm, raw, file (default: mpegts)\n");
    g_print("  -F, --file PATH            Output file path (auto-sets container to file)\n");
    g_print("\n");

    g_print("SHARED MEMORY OPTIONS (when -C shm):\n");
    g_print("  -p, --shm-path PATH        Shared memory socket path (default: %s)\n", DEFAULT_SHM_PATH);
    g_print("  -Z, --shm-size SIZE        Shared memory size in bytes (default: %d)\n", DEFAULT_SHM_SIZE);
    g_print("\n");

    g_print("OTHER OPTIONS:\n");
    g_print("  -S, --stats-interval SEC   Stats print interval, 0=off (default: %d)\n", DEFAULT_STATS_INTERVAL_SEC);
    g_print("  -V, --verbose              Verbose output (show pipeline strings)\n");
    g_print("      --help                 Show this help\n");
    g_print("      --version              Show version\n");
    g_print("\n");

    g_print("CODEC + CONTAINER COMBINATIONS:\n");
    g_print("  h264/mpegts   H.264 in MPEG-TS (default, broadcast compatible)\n");
    g_print("  h264/rtp      H.264 RTP payload (SDP compatible)\n");
    g_print("  h264/file     H.264 in MP4 file\n");
    g_print("  h265/mpegts   H.265/HEVC in MPEG-TS\n");
    g_print("  h265/rtp      H.265/HEVC RTP payload\n");
    g_print("  h265/file     H.265/HEVC in MP4 file\n");
    g_print("  vp8/rtp       VP8 RTP (WebRTC compatible)\n");
    g_print("  vp8/file      VP8 in MKV file\n");
    g_print("  vp9/rtp       VP9 RTP (WebRTC compatible)\n");
    g_print("  vp9/file      VP9 in MKV file\n");
    g_print("  raw/shm       Raw I420 frames to shared memory (IPC)\n");
    g_print("  raw/rtp       Raw video RTP (high bandwidth)\n");
    g_print("\n");

    g_print("EXAMPLES:\n");
    g_print("  %s -i 5000                                    # H.264/MPEG-TS (default)\n", prog);
    g_print("  %s -i 5000 -c vp8 -C rtp                      # VP8/RTP for WebRTC\n", prog);
    g_print("  %s -i 5000 -c h265 -C mpegts -b 4000          # H.265/MPEG-TS 4Mbps\n", prog);
    g_print("  %s -i 5000 -c raw -C shm -p /tmp/fb.sock      # Raw frames to SHM\n", prog);
    g_print("  %s -i 5000 -c h264 -C rtp -w 1920 -h 1080     # H.264/RTP 1080p\n", prog);
    g_print("  %s -i 5000 -F output.mp4                      # Record to MP4 file\n", prog);
    g_print("  %s -i 5000 -c vp9 -F output.mkv               # Record VP9 to MKV\n", prog);
}

static void print_version(void) {
    g_print("SoftwareFrameBuffer v%s\n", VERSION);
}

/* ========== Main ========== */
int main(int argc, char *argv[]) {
    gst_init(&argc, &argv);

    FrameBuffer *fb = framebuffer_new();
    g_fb = fb;

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
        {"codec",         required_argument, 0, 'c'},
        {"container",     required_argument, 0, 'C'},
        {"shm-path",      required_argument, 0, 'p'},
        {"shm-size",      required_argument, 0, 'Z'},
        {"file",          required_argument, 0, 'F'},
        {"stats-interval",required_argument, 0, 'S'},
        {"verbose",       no_argument,       0, 'V'},
        {"help",          no_argument,       0, '?'},
        {"version",       no_argument,       0, 'E'},
        {0, 0, 0, 0}
    };

    int opt;
    int option_index = 0;

    while ((opt = getopt_long(argc, argv, "i:B:j:Q:o:H:w:h:f:b:k:c:C:p:Z:F:S:V",
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
            case 'c':
                fb->codec = string_to_codec(optarg);
                break;
            case 'C':
                fb->container = string_to_container(optarg);
                break;
            case 'p':
                g_free(fb->shm_path);
                fb->shm_path = g_strdup(optarg);
                break;
            case 'Z':
                fb->shm_size = strtoull(optarg, NULL, 10);
                break;
            case 'F':
                fb->output_file = g_strdup(optarg);
                fb->container = CONTAINER_FILE;  /* Auto-set container to file */
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

    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    if (!create_input_pipeline(fb)) {
        g_printerr("Failed to create input pipeline\n");
        return 1;
    }

    if (!create_output_pipeline(fb)) {
        g_printerr("Failed to create output pipeline\n");
        return 1;
    }

    fb->loop = g_main_loop_new(NULL, FALSE);

    if (!framebuffer_start(fb)) {
        g_printerr("Failed to schedule frame buffer start\n");
        return 1;
    }

    g_main_loop_run(fb->loop);

    framebuffer_stop(fb);
    g_main_loop_unref(fb->loop);
    framebuffer_free(fb);

    return 0;
}
