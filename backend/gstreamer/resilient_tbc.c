// resilient_tbc.c
// Ultra-resilient A/B + Soft-TBC + Stable encoder (GStreamer 1.0)
// Build: gcc resilient_tbc.c -o resilient_tbc $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-video-1.0 glib-2.0)
// Run:   ./resilient_tbc

#include <gst/gst.h>
#include <glib.h>
#include <glib/gprintf.h>
#include <string.h>

#define OUTPUT_WIDTH   640
#define OUTPUT_HEIGHT  480
#define OUTPUT_FPS_N   25
#define OUTPUT_FPS_D   1

#define INPUT_PORT     5000
#define OUTPUT_HOST    "127.0.0.1"
#define OUTPUT_PORT    5004

#define WATCHDOG_TIMEOUT_MS 2000
#define RESUME_THRESHOLD_MS 100

typedef struct {
  GstElement *pipeline;

  GstElement *selector;
  GstPad     *fallback_pad;
  GstPad     *ingest_pad;

  GstElement *udpsrc;
  GstElement *inqueue;  // queue2 between udpsrc and tsparse
  GstElement *tsparse;
  GstElement *demux;
  GstElement *decodebin;

  // Decode chain elements (for teardown)
  GstElement *h264parse;
  GstElement *vtdec;

  GstElement *ing_vconv, *ing_vscale, *ing_vrate, *ing_caps, *ing_queue;

  // TBC elements (for flushing on source switch)
  GstElement *tbc_q_in;
  GstElement *tbc_q_out;

  gboolean    ingest_linked;
  gboolean    on_ingest;
  gboolean    rebuilding;  // Flag: currently rebuilding ingest chain

  guint64     last_buffer_time_ms;
  guint64     resume_start_time_ms;

  guint       watchdog_id;

  GMainLoop  *loop;
} App;

// Forward declarations
static void switch_to_fallback(App *app, const char *reason);
static void teardown_ingest_chain(App *app);

static guint64 now_ms(void) {
  return (guint64)(g_get_monotonic_time() / 1000);
}

static void logi(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  g_print("[Resilient] ");
  g_vprintf(fmt, ap);
  g_print("\n");
  va_end(ap);
}

// Helper to safely remove an element from pipeline
static void safe_remove_element(GstElement *pipeline, GstElement **elem) {
  if (*elem) {
    gst_element_set_state(*elem, GST_STATE_NULL);
    gst_bin_remove(GST_BIN(pipeline), *elem);
    *elem = NULL;
  }
}

// Teardown ingest chain for rebuild (when source changes)
static void teardown_ingest_chain(App *app) {
  logi("Tearing down ingest chain for rebuild...");

  // First, release selector ingest pad (disconnects from selector)
  if (app->ingest_pad) {
    // Unlink the pad first
    GstPad *peer = gst_pad_get_peer(app->ingest_pad);
    if (peer) {
      gst_pad_unlink(peer, app->ingest_pad);
      gst_object_unref(peer);
    }
    gst_element_release_request_pad(app->selector, app->ingest_pad);
    gst_object_unref(app->ingest_pad);
    app->ingest_pad = NULL;
  }

  // Remove ingest normalize chain (in reverse order)
  safe_remove_element(app->pipeline, &app->ing_queue);
  safe_remove_element(app->pipeline, &app->ing_caps);
  safe_remove_element(app->pipeline, &app->ing_vrate);
  safe_remove_element(app->pipeline, &app->ing_vscale);
  safe_remove_element(app->pipeline, &app->ing_vconv);

  // Remove decode chain
  safe_remove_element(app->pipeline, &app->vtdec);
  safe_remove_element(app->pipeline, &app->h264parse);

  // Don't remove decodebin if it's the same as vtdec (we use vtdec as marker)
  if (app->decodebin && app->decodebin != app->vtdec) {
    safe_remove_element(app->pipeline, &app->decodebin);
  }
  app->decodebin = NULL;

  app->ingest_linked = FALSE;
  logi("Ingest chain torn down, ready for rebuild");
}

// Forward declaration for on_demux_pad_added
static void on_demux_pad_added(GstElement *demux, GstPad *pad, gpointer user_data);

// Rebuild ingest chain (called from main thread via g_idle_add)
static gboolean rebuild_ingest_chain(gpointer user_data) {
  App *app = (App *)user_data;

  logi("Rebuilding ingest chain for new source...");

  // 1. Make sure we're on fallback
  switch_to_fallback(app, "rebuild");

  // 2. Teardown existing decode chain
  teardown_ingest_chain(app);

  // 3. Restart entire ingest path (udpsrc -> inqueue -> tsparse -> demux)
  if (app->demux && app->tsparse && app->inqueue && app->udpsrc) {
    // Pause udpsrc to stop receiving while we rebuild
    gst_element_set_state(app->udpsrc, GST_STATE_READY);

    // Unlink the chain properly: inqueue -> tsparse -> demux
    gst_element_unlink(app->inqueue, app->tsparse);
    gst_element_unlink(app->tsparse, app->demux);

    // Set to NULL and remove old tsparse and demux
    gst_element_set_state(app->demux, GST_STATE_NULL);
    gst_element_set_state(app->tsparse, GST_STATE_NULL);
    gst_bin_remove(GST_BIN(app->pipeline), app->demux);
    gst_bin_remove(GST_BIN(app->pipeline), app->tsparse);

    // Flush the inqueue to clear old data and reset running time
    GstPad *inq_sink = gst_element_get_static_pad(app->inqueue, "sink");
    if (inq_sink) {
      gst_pad_send_event(inq_sink, gst_event_new_flush_start());
      gst_pad_send_event(inq_sink, gst_event_new_flush_stop(TRUE));  // TRUE = reset running_time
      gst_object_unref(inq_sink);
      logi("Flushed inqueue with running_time reset");
    }
    // Note: Don't flush TBC queues - they handle discontinuities via leaky=2

    // Create new tsparse
    app->tsparse = gst_element_factory_make("tsparse", "tsparse");
    g_object_set(app->tsparse, "set-timestamps", TRUE, NULL);

    // Create new demux
    app->demux = gst_element_factory_make("tsdemux", "demux");
    g_object_set(app->demux, "program-number", -1, NULL);
    g_signal_connect(app->demux, "pad-added", G_CALLBACK(on_demux_pad_added), app);

    // Add to pipeline and link: inqueue -> tsparse -> demux
    gst_bin_add_many(GST_BIN(app->pipeline), app->tsparse, app->demux, NULL);
    if (!gst_element_link_many(app->inqueue, app->tsparse, app->demux, NULL)) {
      logi("ERROR: failed to relink inqueue -> tsparse -> demux");
    }

    // Sync all states - important to restart udpsrc last
    gst_element_sync_state_with_parent(app->tsparse);
    gst_element_sync_state_with_parent(app->demux);
    gst_element_set_state(app->udpsrc, GST_STATE_PLAYING);

    logi("Restarted ingest path (flushed queue, new tsparse + tsdemux)");
  }

  app->rebuilding = FALSE;
  logi("Ingest chain rebuilt, waiting for new source...");

  return G_SOURCE_REMOVE;  // Don't call again
}

static void switch_to_fallback(App *app, const char *reason) {
  if (!app->selector || !app->fallback_pad) return;
  if (app->on_ingest) {
    g_object_set(app->selector, "active-pad", app->fallback_pad, NULL);
    app->on_ingest = FALSE;
    app->resume_start_time_ms = 0;
    logi(">>> SWITCHED TO FALLBACK (%s)", reason ? reason : "watchdog");
  }
}

static void switch_to_ingest(App *app) {
  if (!app->selector || !app->ingest_pad) return;
  if (!app->on_ingest) {
    g_object_set(app->selector, "active-pad", app->ingest_pad, NULL);
    app->on_ingest = TRUE;
    app->resume_start_time_ms = 0;
    logi(">>> SWITCHED TO INGEST");
  }
}

static gboolean delayed_switch_to_ingest(gpointer user_data) {
  App *app = (App *)user_data;
  switch_to_ingest(app);
  return FALSE;
}

static GstPadProbeReturn ingest_probe_cb(GstPad *pad, GstPadProbeInfo *info, gpointer user_data) {
  App *app = (App *)user_data;
  if (!(info->type & GST_PAD_PROBE_TYPE_BUFFER)) return GST_PAD_PROBE_OK;

  guint64 t = now_ms();
  app->last_buffer_time_ms = t;

  if (!app->on_ingest) {
    if (app->resume_start_time_ms == 0) {
      app->resume_start_time_ms = t;
      logi("Detected ingest buffers, monitoring for resume...");
    } else if ((t - app->resume_start_time_ms) > RESUME_THRESHOLD_MS) {
      logi("Stable ingest for %dms -> resuming", RESUME_THRESHOLD_MS);
      switch_to_ingest(app);
    }
  }

  return GST_PAD_PROBE_OK;
}

static gboolean watchdog_cb(gpointer user_data) {
  App *app = (App *)user_data;
  if (!app->on_ingest) return TRUE;
  if (app->last_buffer_time_ms == 0) return TRUE;

  guint64 t = now_ms();
  guint64 elapsed = t - app->last_buffer_time_ms;
  if (elapsed > WATCHDOG_TIMEOUT_MS) {
    logi("Watchdog: no data for %lums", (unsigned long)elapsed);
    switch_to_fallback(app, "watchdog");
  }
  return TRUE;
}

static gboolean link_ingest_chain(App *app, GstPad *raw_video_src_pad) {
  GstCaps *caps = gst_caps_new_simple(
    "video/x-raw",
    "format", G_TYPE_STRING, "NV12",
    "width",  G_TYPE_INT, OUTPUT_WIDTH,
    "height", G_TYPE_INT, OUTPUT_HEIGHT,
    "framerate", GST_TYPE_FRACTION, OUTPUT_FPS_N, OUTPUT_FPS_D,
    "colorimetry", G_TYPE_STRING, "bt709",
    NULL
  );

  app->ing_vconv  = gst_element_factory_make("videoconvert", "ing_vconv");
  app->ing_vscale = gst_element_factory_make("videoscale",   "ing_vscale");
  app->ing_vrate  = gst_element_factory_make("videorate",    "ing_vrate");
  app->ing_caps   = gst_element_factory_make("capsfilter",   "ing_caps");
  app->ing_queue  = gst_element_factory_make("queue",        "ing_queue");

  if (!app->ing_vconv || !app->ing_vscale || !app->ing_vrate || !app->ing_caps || !app->ing_queue) {
    logi("ERROR: failed to create ingest normalize elements");
    gst_caps_unref(caps);
    return FALSE;
  }

  g_object_set(app->ing_caps, "caps", caps, NULL);
  gst_caps_unref(caps);

  g_object_set(app->ing_queue, "max-size-buffers", 2, "leaky", 2, NULL);
  g_object_set(app->ing_vrate, "skip-to-first", TRUE, "drop-only", TRUE, NULL);
  g_object_set(app->ing_vscale, "method", 0, "n-threads", 4, NULL);  // nearest-neighbour + multithreaded
  g_object_set(app->ing_vconv, "n-threads", 4, NULL);  // multithreaded colorspace conversion

  gst_bin_add_many(GST_BIN(app->pipeline),
                   app->ing_vconv, app->ing_vscale, app->ing_vrate, app->ing_caps, app->ing_queue,
                   NULL);

  gst_element_sync_state_with_parent(app->ing_vconv);
  gst_element_sync_state_with_parent(app->ing_vscale);
  gst_element_sync_state_with_parent(app->ing_vrate);
  gst_element_sync_state_with_parent(app->ing_caps);
  gst_element_sync_state_with_parent(app->ing_queue);

  if (!gst_element_link_many(app->ing_vconv, app->ing_vscale, app->ing_vrate, app->ing_caps, app->ing_queue, NULL)) {
    logi("ERROR: failed to link ingest normalize chain");
    return FALSE;
  }

  GstPad *vconv_sink = gst_element_get_static_pad(app->ing_vconv, "sink");
  if (gst_pad_link(raw_video_src_pad, vconv_sink) != GST_PAD_LINK_OK) {
    logi("ERROR: failed to link decodebin raw pad to ingest chain");
    gst_object_unref(vconv_sink);
    return FALSE;
  }
  gst_object_unref(vconv_sink);

  app->ingest_pad = gst_element_request_pad_simple(app->selector, "sink_%u");
  if (!app->ingest_pad) {
    logi("ERROR: could not request selector sink pad");
    return FALSE;
  }

  GstPad *q_src = gst_element_get_static_pad(app->ing_queue, "src");
  if (gst_pad_link(q_src, app->ingest_pad) != GST_PAD_LINK_OK) {
    logi("ERROR: failed to link ingest queue to selector pad");
    gst_object_unref(q_src);
    return FALSE;
  }
  gst_object_unref(q_src);

  gst_pad_add_probe(app->ingest_pad, GST_PAD_PROBE_TYPE_BUFFER, ingest_probe_cb, app, NULL);

  app->ingest_linked = TRUE;
  app->last_buffer_time_ms = now_ms();
  logi("Ingest linked to selector (%s)", GST_PAD_NAME(app->ingest_pad));

  if (app->watchdog_id == 0) {
    app->watchdog_id = g_timeout_add(500, watchdog_cb, app);
  }

  g_timeout_add(500, delayed_switch_to_ingest, app);
  return TRUE;
}

static void on_decode_pad_added(GstElement *decodebin, GstPad *pad, gpointer user_data) {
  App *app = (App *)user_data;
  if (app->ingest_linked) return;

  GstCaps *caps = gst_pad_get_current_caps(pad);
  if (!caps) caps = gst_pad_query_caps(pad, NULL);
  if (!caps) return;

  GstStructure *s = gst_caps_get_structure(caps, 0);
  const gchar *name = gst_structure_get_name(s);

  if (g_str_has_prefix(name, "video/x-raw")) {
    logi("Decoder produced video/x-raw -> linking ingest chain");
    link_ingest_chain(app, pad);
  }
  gst_caps_unref(caps);
}

static void on_demux_pad_added(GstElement *demux, GstPad *pad, gpointer user_data) {
  App *app = (App *)user_data;

  GstCaps *caps = gst_pad_get_current_caps(pad);
  if (!caps) caps = gst_pad_query_caps(pad, NULL);
  if (!caps) return;

  GstStructure *s = gst_caps_get_structure(caps, 0);
  const gchar *name = gst_structure_get_name(s);

  // If we already have a decode chain, ignore new source (restart pipeline to change source)
  if (app->decodebin) {
    if (g_str_has_prefix(name, "video/")) {
      logi("New source detected but chain exists - ignoring (restart pipeline to change source)");
    }
    gst_caps_unref(caps);
    return;
  }

  if (g_str_has_prefix(name, "video/x-h264")) {
    logi("Demux pad: %s -> creating H264 HW decode chain", name);

    app->h264parse = gst_element_factory_make("h264parse", NULL);
    app->vtdec = gst_element_factory_make("vtdec", NULL);  // vtdec more flexible than vtdec_hw
    if (!app->h264parse || !app->vtdec) {
      logi("ERROR: cannot create h264parse or vtdec");
      gst_caps_unref(caps);
      return;
    }

    gst_bin_add_many(GST_BIN(app->pipeline), app->h264parse, app->vtdec, NULL);
    gst_element_link(app->h264parse, app->vtdec);

    GstPad *parse_sink = gst_element_get_static_pad(app->h264parse, "sink");
    if (gst_pad_link(pad, parse_sink) != GST_PAD_LINK_OK) {
      logi("ERROR: failed linking demux -> h264parse");
    } else {
      logi("Linked demux -> h264parse -> vtdec (HW)");
    }
    gst_object_unref(parse_sink);

    gst_element_sync_state_with_parent(app->h264parse);
    gst_element_sync_state_with_parent(app->vtdec);

    GstPad *vtdec_src = gst_element_get_static_pad(app->vtdec, "src");
    link_ingest_chain(app, vtdec_src);
    gst_object_unref(vtdec_src);

    app->decodebin = app->vtdec; // Mark as linked

  } else if (g_str_has_prefix(name, "video/x-h265")) {
    logi("Demux pad: %s -> creating H265/HEVC HW decode chain", name);

    GstElement *h265parse = gst_element_factory_make("h265parse", NULL);
    app->vtdec = gst_element_factory_make("vtdec", NULL);  // vtdec supports HEVC
    if (!h265parse || !app->vtdec) {
      logi("ERROR: cannot create h265parse or vtdec");
      gst_caps_unref(caps);
      return;
    }

    gst_bin_add_many(GST_BIN(app->pipeline), h265parse, app->vtdec, NULL);
    gst_element_link(h265parse, app->vtdec);

    GstPad *parse_sink = gst_element_get_static_pad(h265parse, "sink");
    if (gst_pad_link(pad, parse_sink) != GST_PAD_LINK_OK) {
      logi("ERROR: failed linking demux -> h265parse");
    } else {
      logi("Linked demux -> h265parse -> vtdec (HW HEVC)");
    }
    gst_object_unref(parse_sink);

    gst_element_sync_state_with_parent(h265parse);
    gst_element_sync_state_with_parent(app->vtdec);

    GstPad *vtdec_src = gst_element_get_static_pad(app->vtdec, "src");
    link_ingest_chain(app, vtdec_src);
    gst_object_unref(vtdec_src);

    app->h264parse = h265parse;  // Reuse pointer for teardown
    app->decodebin = app->vtdec; // Mark as linked

  } else if (g_str_has_prefix(name, "video/")) {
    logi("Demux pad: %s -> creating decodebin (fallback)", name);

    app->decodebin = gst_element_factory_make("decodebin", NULL);
    if (!app->decodebin) {
      logi("ERROR: cannot create decodebin");
      gst_caps_unref(caps);
      return;
    }

    gst_bin_add(GST_BIN(app->pipeline), app->decodebin);
    gst_element_sync_state_with_parent(app->decodebin);

    g_signal_connect(app->decodebin, "pad-added", G_CALLBACK(on_decode_pad_added), app);

    GstPad *db_sink = gst_element_get_static_pad(app->decodebin, "sink");
    if (gst_pad_link(pad, db_sink) != GST_PAD_LINK_OK) {
      logi("ERROR: failed linking demux video pad -> decodebin sink");
    } else {
      logi("Linked demux -> decodebin");
    }
    gst_object_unref(db_sink);
  }

  gst_caps_unref(caps);
}

static gboolean build_pipeline(App *app) {
  app->pipeline = gst_pipeline_new("resilient-pipe");
  if (!app->pipeline) return FALSE;

  app->selector = gst_element_factory_make("input-selector", "sel");
  if (!app->selector) return FALSE;
  g_object_set(app->selector, "sync-streams", FALSE, "cache-buffers", TRUE, NULL);

  GstElement *fallback = gst_element_factory_make("videotestsrc", "fallback");
  GstElement *overlay  = gst_element_factory_make("textoverlay", "nosig");
  GstElement *fb_vc    = gst_element_factory_make("videoconvert", "fb_vc");
  GstElement *fb_vs    = gst_element_factory_make("videoscale",   "fb_vs");
  GstElement *fb_vr    = gst_element_factory_make("videorate",    "fb_vr");
  GstElement *fb_caps  = gst_element_factory_make("capsfilter",   "fb_caps");
  GstElement *fb_q     = gst_element_factory_make("queue",        "fb_q");

  if (!fallback || !overlay || !fb_vc || !fb_vs || !fb_vr || !fb_caps || !fb_q) return FALSE;

  g_object_set(fallback, "is-live", TRUE, "pattern", 0, NULL);
  g_object_set(overlay,
               "text", "NO SIGNAL",
               "valignment", 2,
               "halignment", 2,
               "font-desc", "Sans Bold 72",
               NULL);
  g_object_set(fb_q, "max-size-buffers", 3, NULL);
  g_object_set(fb_vc, "n-threads", 4, NULL);
  g_object_set(fb_vs, "n-threads", 4, NULL);

  GstCaps *out_caps = gst_caps_new_simple(
    "video/x-raw",
    "format", G_TYPE_STRING, "NV12",
    "width",  G_TYPE_INT, OUTPUT_WIDTH,
    "height", G_TYPE_INT, OUTPUT_HEIGHT,
    "framerate", GST_TYPE_FRACTION, OUTPUT_FPS_N, OUTPUT_FPS_D,
    "colorimetry", G_TYPE_STRING, "bt709",
    NULL
  );
  g_object_set(fb_caps, "caps", out_caps, NULL);
  gst_caps_unref(out_caps);

  app->udpsrc  = gst_element_factory_make("udpsrc", "udpin");
  app->inqueue = gst_element_factory_make("queue2", "inqueue");
  app->tsparse = gst_element_factory_make("tsparse", "tsparse");
  app->demux   = gst_element_factory_make("tsdemux", "demux");

  if (!app->udpsrc || !app->inqueue || !app->tsparse || !app->demux) return FALSE;

  g_object_set(app->udpsrc, "port", INPUT_PORT, "buffer-size", 8388608, NULL);
  g_object_set(app->inqueue, "use-buffering", TRUE, "max-size-time", (gint64)2000000000, NULL);
  g_object_set(app->tsparse, "set-timestamps", TRUE, NULL);

  app->tbc_q_in  = gst_element_factory_make("queue",    "tbc_in");
  GstElement *tbc_id    = gst_element_factory_make("identity", "tbc");
  GstElement *tbc_vr    = gst_element_factory_make("videorate","tbcrate");
  GstElement *tbc_caps  = gst_element_factory_make("capsfilter","tbc_caps");
  app->tbc_q_out = gst_element_factory_make("queue",    "tbc_out");

  GstElement *conv2 = gst_element_factory_make("videoconvert", "out_vc");
  GstElement *scale2= gst_element_factory_make("videoscale",   "out_vs");
  GstElement *vp8   = gst_element_factory_make("vtenc_h264_hw", "encoder");
  GstElement *pay   = gst_element_factory_make("rtph264pay",    "pay");
  GstElement *sink  = gst_element_factory_make("udpsink",      "outsink");

  if (!app->tbc_q_in || !tbc_id || !tbc_vr || !tbc_caps || !app->tbc_q_out || !conv2 || !scale2 || !vp8 || !pay || !sink) return FALSE;

  g_object_set(app->tbc_q_in,  "max-size-time", (gint64)500000000, "leaky", 2, NULL);
  g_object_set(app->tbc_q_out, "max-size-time", (gint64)200000000, "leaky", 2, NULL);

  g_object_set(tbc_id, "sync", TRUE, NULL);
  g_object_set(tbc_vr, "drop-only", FALSE, "skip-to-first", TRUE, NULL);
  g_object_set(conv2, "n-threads", 4, NULL);
  g_object_set(scale2, "n-threads", 4, NULL);

  GstCaps *tbc_out_caps = gst_caps_new_simple(
    "video/x-raw",
    "format", G_TYPE_STRING, "NV12",
    "width",  G_TYPE_INT, OUTPUT_WIDTH,
    "height", G_TYPE_INT, OUTPUT_HEIGHT,
    "framerate", GST_TYPE_FRACTION, OUTPUT_FPS_N, OUTPUT_FPS_D,
    "colorimetry", G_TYPE_STRING, "bt709",
    NULL
  );
  g_object_set(tbc_caps, "caps", tbc_out_caps, NULL);
  gst_caps_unref(tbc_out_caps);

  g_object_set(vp8,
               "bitrate", 1500,
               "max-keyframe-interval", OUTPUT_FPS_N,
               "realtime", TRUE,
               NULL);

  g_object_set(pay, "pt", 96, "mtu", 1400, "config-interval", -1, NULL);
  g_object_set(sink,
               "host", OUTPUT_HOST,
               "port", OUTPUT_PORT,
               "sync", FALSE,
               "async", FALSE,
               NULL);

  gst_bin_add_many(GST_BIN(app->pipeline),
                   app->selector,
                   fallback, overlay, fb_vc, fb_vs, fb_vr, fb_caps, fb_q,
                   app->udpsrc, app->inqueue, app->tsparse, app->demux,
                   app->tbc_q_in, tbc_id, tbc_vr, tbc_caps, app->tbc_q_out,
                   conv2, scale2, vp8, pay, sink,
                   NULL);

  if (!gst_element_link_many(fallback, overlay, fb_vc, fb_vs, fb_vr, fb_caps, fb_q, NULL)) {
    logi("ERROR: failed to link fallback chain");
    return FALSE;
  }

  GstPad *fb_q_src = gst_element_get_static_pad(fb_q, "src");
  app->fallback_pad = gst_element_request_pad_simple(app->selector, "sink_%u");
  if (!app->fallback_pad) {
    logi("ERROR: could not request fallback sink pad");
    gst_object_unref(fb_q_src);
    return FALSE;
  }
  if (gst_pad_link(fb_q_src, app->fallback_pad) != GST_PAD_LINK_OK) {
    logi("ERROR: failed to link fallback queue to selector");
    gst_object_unref(fb_q_src);
    return FALSE;
  }
  gst_object_unref(fb_q_src);
  logi("Fallback linked to selector (%s)", GST_PAD_NAME(app->fallback_pad));

  if (!gst_element_link_many(app->udpsrc, app->inqueue, app->tsparse, app->demux, NULL)) {
    logi("ERROR: failed to link ingest base chain");
    return FALSE;
  }

  if (!gst_element_link_many(app->selector, app->tbc_q_in, tbc_id, tbc_vr, tbc_caps, app->tbc_q_out, conv2, scale2, vp8, pay, sink, NULL)) {
    logi("ERROR: failed to link stable output chain");
    return FALSE;
  }

  g_object_set(app->selector, "active-pad", app->fallback_pad, NULL);
  app->on_ingest = FALSE;
  logi(">>> FALLBACK ACTIVE (%s)", GST_PAD_NAME(app->fallback_pad));

  g_signal_connect(app->demux, "pad-added", G_CALLBACK(on_demux_pad_added), app);

  return TRUE;
}

static void on_bus_msg(GstBus *bus, GstMessage *msg, gpointer user_data) {
  App *app = (App *)user_data;

  switch (GST_MESSAGE_TYPE(msg)) {
    case GST_MESSAGE_ERROR: {
      GError *err = NULL;
      gchar  *dbg = NULL;
      gst_message_parse_error(msg, &err, &dbg);
      const gchar *src = GST_OBJECT_NAME(msg->src);

      logi("ERROR from %s: %s", src, err ? err->message : "unknown");

      if (src && (
          strcmp(src, "udpin") == 0 ||
          strcmp(src, "inqueue") == 0 ||
          strcmp(src, "tsparse") == 0 ||
          strcmp(src, "demux") == 0 ||
          strcmp(src, "decoder") == 0 ||
          strcmp(src, "ing_vconv") == 0
      )) {
        switch_to_fallback(app, "ingest-error");
        // Trigger rebuild for new source
        if (app->decodebin && !app->rebuilding) {
          app->rebuilding = TRUE;
          g_idle_add(rebuild_ingest_chain, app);
        }
      } else {
        logi("FATAL: core pipeline error -> quitting");
        if (app->loop) g_main_loop_quit(app->loop);
      }

      if (err) g_error_free(err);
      g_free(dbg);
      break;
    }
    case GST_MESSAGE_WARNING: {
      GError *err = NULL;
      gchar  *dbg = NULL;
      gst_message_parse_warning(msg, &err, &dbg);
      const gchar *src = GST_OBJECT_NAME(msg->src);
      logi("WARNING from %s: %s", src, err ? err->message : "unknown");
      if (err) g_error_free(err);
      g_free(dbg);
      break;
    }
    case GST_MESSAGE_STATE_CHANGED: {
      if (GST_MESSAGE_SRC(msg) == GST_OBJECT(app->pipeline)) {
        GstState old_s, new_s, pend_s;
        gst_message_parse_state_changed(msg, &old_s, &new_s, &pend_s);
        logi("Pipeline: %s -> %s", gst_element_state_get_name(old_s), gst_element_state_get_name(new_s));
      }
      break;
    }
    default:
      break;
  }
}

int main(int argc, char **argv) {
  gst_init(&argc, &argv);

  App app;
  memset(&app, 0, sizeof(App));

  logi("============================================================");
  logi("ULTRA-RESILIENT VIDEO PIPELINE (C)  A/B + TBC + WATCHDOG");
  logi("============================================================");
  logi("Input:  UDP TS port %d (variable codec/res/fps)", INPUT_PORT);
  logi("Output: %s:%d (RTP H264 HW) fixed %dx%d@%d",
       OUTPUT_HOST, OUTPUT_PORT, OUTPUT_WIDTH, OUTPUT_HEIGHT, OUTPUT_FPS_N);
  logi("Watchdog: %dms timeout, %dms resume", WATCHDOG_TIMEOUT_MS, RESUME_THRESHOLD_MS);

  if (!build_pipeline(&app)) {
    logi("ERROR: build_pipeline failed");
    return 1;
  }

  GstBus *bus = gst_element_get_bus(app.pipeline);
  gst_bus_add_signal_watch(bus);
  g_signal_connect(bus, "message", G_CALLBACK(on_bus_msg), &app);
  gst_object_unref(bus);

  GstStateChangeReturn ret = gst_element_set_state(app.pipeline, GST_STATE_PLAYING);
  if (ret == GST_STATE_CHANGE_FAILURE) {
    logi("ERROR: failed to set pipeline to PLAYING");
    gst_object_unref(app.pipeline);
    return 1;
  }

  if (app.watchdog_id == 0) {
    app.watchdog_id = g_timeout_add(500, watchdog_cb, &app);
  }

  app.loop = g_main_loop_new(NULL, FALSE);
  g_main_loop_run(app.loop);

  logi("Stopping...");
  if (app.watchdog_id) g_source_remove(app.watchdog_id);
  gst_element_set_state(app.pipeline, GST_STATE_NULL);

  if (app.fallback_pad) gst_object_unref(app.fallback_pad);
  if (app.ingest_pad) gst_object_unref(app.ingest_pad);

  gst_object_unref(app.pipeline);
  g_main_loop_unref(app.loop);

  return 0;
}
