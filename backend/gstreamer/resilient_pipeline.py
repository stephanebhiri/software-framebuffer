#!/usr/bin/env python3
"""
Ultra-Resilient GStreamer Pipeline with TBC (Time Base Corrector)
Architecture: A/B + TBC + immortal encoder = hardware-grade decoder

- A = Ingest (disposable, can crash/change)
- B = Fallback (always stable, SMPTE bars)
- TBC = identity sync=true single-segment=true + videorate
- Encoder = never restarted, continuous clock
- Watchdog = automatic fallback on no data, auto-resume on new data
"""

import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib
import sys
import time

# Output configuration (fixed, never changes)
OUTPUT_WIDTH = 640
OUTPUT_HEIGHT = 480
OUTPUT_FPS = 25
OUTPUT_HOST = "127.0.0.1"
OUTPUT_PORT = 5004
INPUT_PORT = 5000
WATCHDOG_TIMEOUT_MS = 2000  # 2 seconds without data = fallback
RESUME_THRESHOLD_MS = 100   # Resume to ingest after 100ms of good buffers

class ResilientPipeline:
    def __init__(self):
        Gst.init(None)
        self.pipeline = None
        self.loop = None
        self.selector = None
        self.ingest_linked = False
        self.fallback_pad = None
        self.ingest_pad = None
        self.last_buffer_time = 0
        self.resume_start_time = 0
        self.watchdog_id = None
        self.is_on_ingest = False

    def log(self, msg):
        print(f"[Resilient] {msg}", flush=True)

    def build_pipeline(self):
        """Build the resilient pipeline with A/B switch + TBC."""

        # Fixed output caps
        output_caps = f"video/x-raw,format=I420,width={OUTPUT_WIDTH},height={OUTPUT_HEIGHT},framerate={OUTPUT_FPS}/1"

        pipeline_str = f"""
            input-selector name=sel sync-streams=false cache-buffers=true

            videotestsrc name=fallback is-live=true pattern=smpte
            ! textoverlay text="NO SIGNAL" valignment=center halignment=center font-desc="Sans Bold 72"
            ! videoconvert ! videoscale ! videorate
            ! {output_caps}
            ! queue max-size-buffers=3
            ! sel.sink_0

            udpsrc name=udpin port={INPUT_PORT} buffer-size=8388608
            ! queue2 name=inqueue use-buffering=true max-size-time=2000000000
            ! tsparse set-timestamps=true
            ! tsdemux name=demux

            sel.
            ! queue name=tbc-in max-size-time=500000000 leaky=downstream
            ! identity name=tbc sync=true single-segment=true
            ! videorate name=tbcrate drop-only=false skip-to-first=true
            ! {output_caps}
            ! queue name=tbc-out max-size-time=200000000 leaky=downstream

            ! videoconvert ! videoscale
            ! vp8enc name=encoder deadline=1 cpu-used=8 target-bitrate=1500000 keyframe-max-dist={OUTPUT_FPS} threads=4
            ! rtpvp8pay pt=96 mtu=1400
            ! udpsink host={OUTPUT_HOST} port={OUTPUT_PORT} sync=false async=false
        """

        self.pipeline = Gst.parse_launch(pipeline_str)
        if not self.pipeline:
            self.log("ERROR: Failed to create pipeline")
            return False

        self.selector = self.pipeline.get_by_name("sel")
        demux = self.pipeline.get_by_name("demux")

        # Get the fallback pad
        self.fallback_pad = self.selector.get_static_pad("sink_0")
        self.log(f"Fallback pad: {self.fallback_pad.get_name()}")

        # Start with fallback active
        self.selector.set_property("active-pad", self.fallback_pad)
        self.is_on_ingest = False
        self.log(">>> FALLBACK ACTIVE (sink_0)")

        # Dynamic linking for tsdemux video pad
        def on_demux_pad(demux, pad):
            caps = pad.get_current_caps()
            if not caps:
                caps = pad.query_caps(None)

            if caps and caps.get_size() > 0:
                struct = caps.get_structure(0)
                name = struct.get_name()
                self.log(f"Demux pad: {name}")

                if name.startswith("video/") and not self.ingest_linked:
                    self.log("Creating ingest processing chain...")

                    decode = Gst.ElementFactory.make("decodebin", "decoder")

                    def on_decode_pad(dbin, dpad):
                        dcaps = dpad.get_current_caps()
                        if not dcaps:
                            dcaps = dpad.query_caps(None)
                        if dcaps and dcaps.get_size() > 0:
                            dstruct = dcaps.get_structure(0)
                            if dstruct.get_name().startswith("video/x-raw"):
                                self.log("Decoder video output ready")
                                self.link_ingest_to_selector(dpad)

                    decode.connect("pad-added", on_decode_pad)

                    self.pipeline.add(decode)
                    decode.sync_state_with_parent()

                    pad.link(decode.get_static_pad("sink"))

        demux.connect("pad-added", on_demux_pad)

        # Error handling
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message::error", self.on_error)
        bus.connect("message::warning", self.on_warning)
        bus.connect("message::state-changed", self.on_state_changed)

        return True

    def buffer_probe(self, pad, info):
        """Called for each buffer on the ingest pad - updates watchdog timer."""
        now = time.time() * 1000
        self.last_buffer_time = now

        # If we're on fallback but receiving buffers, consider resuming
        if not self.is_on_ingest:
            if self.resume_start_time == 0:
                self.resume_start_time = now
                self.log("Detected new ingest buffers, monitoring for resume...")
            elif (now - self.resume_start_time) > RESUME_THRESHOLD_MS:
                self.log(f"Stable ingest for {RESUME_THRESHOLD_MS}ms, resuming")
                self.switch_to_ingest()

        return Gst.PadProbeReturn.OK

    def watchdog_check(self):
        """Check if we haven't received a buffer in a while."""
        now = time.time() * 1000

        if self.is_on_ingest and self.last_buffer_time > 0:
            elapsed = now - self.last_buffer_time
            if elapsed > WATCHDOG_TIMEOUT_MS:
                self.log(f"Watchdog: no data for {elapsed:.0f}ms")
                self.switch_to_fallback()

        return True  # Keep running

    def link_ingest_to_selector(self, video_pad):
        """Link the decoded video to selector via conversion chain."""

        output_caps = f"video/x-raw,format=I420,width={OUTPUT_WIDTH},height={OUTPUT_HEIGHT},framerate={OUTPUT_FPS}/1"

        convert = Gst.ElementFactory.make("videoconvert", "ingest-convert")
        scale = Gst.ElementFactory.make("videoscale", "ingest-scale")
        rate = Gst.ElementFactory.make("videorate", "ingest-rate")
        rate.set_property("skip-to-first", True)

        caps = Gst.ElementFactory.make("capsfilter", "ingest-caps")
        caps.set_property("caps", Gst.Caps.from_string(output_caps))

        queue = Gst.ElementFactory.make("queue", "ingest-queue")
        queue.set_property("max-size-buffers", 3)

        for elem in [convert, scale, rate, caps, queue]:
            self.pipeline.add(elem)
            elem.sync_state_with_parent()

        convert.link(scale)
        scale.link(rate)
        rate.link(caps)
        caps.link(queue)

        sink = convert.get_static_pad("sink")
        if video_pad.link(sink) == Gst.PadLinkReturn.OK:
            self.log("Video linked to conversion chain")
        else:
            self.log("ERROR: Failed to link video to conversion chain")
            return

        # Request sink_1 on selector
        self.ingest_pad = self.selector.request_pad_simple("sink_%u")
        queue.get_static_pad("src").link(self.ingest_pad)

        # Add buffer probe for watchdog
        self.ingest_pad.add_probe(Gst.PadProbeType.BUFFER, self.buffer_probe)
        self.last_buffer_time = time.time() * 1000

        self.ingest_linked = True
        self.log(f"Ingest linked to selector ({self.ingest_pad.get_name()})")

        # Start watchdog
        if self.watchdog_id is None:
            self.watchdog_id = GLib.timeout_add(500, self.watchdog_check)

        # Switch to ingest
        GLib.timeout_add(500, self.switch_to_ingest)

    def switch_to_ingest(self):
        """Switch to ingest."""
        if self.ingest_pad and not self.is_on_ingest:
            self.selector.set_property("active-pad", self.ingest_pad)
            self.is_on_ingest = True
            self.resume_start_time = 0
            self.log(">>> SWITCHED TO INGEST")
        return False

    def switch_to_fallback(self):
        """Switch to fallback."""
        if self.is_on_ingest:
            self.selector.set_property("active-pad", self.fallback_pad)
            self.is_on_ingest = False
            self.resume_start_time = 0
            self.log(">>> SWITCHED TO FALLBACK (watchdog)")

    def on_error(self, bus, msg):
        """Handle pipeline errors."""
        err, debug = msg.parse_error()
        src_name = msg.src.get_name() if msg.src else "unknown"
        self.log(f"ERROR from {src_name}: {err.message}")

        if src_name in ["udpin", "inqueue", "demux", "decoder", "ingest-convert"]:
            self.log("Ingest error, switching to fallback")
            self.switch_to_fallback()
        else:
            self.log("FATAL: Core pipeline error")
            self.loop.quit()

    def on_warning(self, bus, msg):
        """Handle pipeline warnings."""
        warn, debug = msg.parse_warning()
        src_name = msg.src.get_name() if msg.src else "unknown"
        self.log(f"WARNING from {src_name}: {warn.message}")

    def on_state_changed(self, bus, msg):
        """Log pipeline state changes."""
        if msg.src == self.pipeline:
            old, new, pending = msg.parse_state_changed()
            self.log(f"Pipeline: {old.value_nick} -> {new.value_nick}")

    def run(self):
        """Start the pipeline."""
        self.log("=" * 60)
        self.log("ULTRA-RESILIENT VIDEO PIPELINE (A/B + TBC + WATCHDOG)")
        self.log("=" * 60)

        if not self.build_pipeline():
            return False

        self.log(f"Input:   UDP port {INPUT_PORT} (any codec/resolution)")
        self.log(f"Output:  {OUTPUT_HOST}:{OUTPUT_PORT} (VP8 RTP)")
        self.log(f"Format:  {OUTPUT_WIDTH}x{OUTPUT_HEIGHT} @ {OUTPUT_FPS}fps")
        self.log(f"TBC:     identity sync=true single-segment=true + videorate")
        self.log(f"Watchdog: {WATCHDOG_TIMEOUT_MS}ms timeout, {RESUME_THRESHOLD_MS}ms resume")
        self.log("-" * 60)

        ret = self.pipeline.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            self.log("Failed to start pipeline")
            return False

        self.log("Pipeline started with FALLBACK")

        self.loop = GLib.MainLoop()
        try:
            self.loop.run()
        except KeyboardInterrupt:
            self.log("\nStopping...")
        finally:
            if self.watchdog_id:
                GLib.source_remove(self.watchdog_id)
            self.pipeline.set_state(Gst.State.NULL)

        return True


if __name__ == "__main__":
    pipeline = ResilientPipeline()
    sys.exit(0 if pipeline.run() else 1)
