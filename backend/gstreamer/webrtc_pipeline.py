#!/usr/bin/env python3
"""
GStreamer WebRTC Pipeline Manager
Handles video ingest, encoding, and WebRTC delivery to multiple clients.
Communicates with Node.js via Unix socket for signaling.
"""

import gi
gi.require_version('Gst', '1.0')
gi.require_version('GstWebRTC', '1.0')
gi.require_version('GstSdp', '1.0')
from gi.repository import Gst, GstWebRTC, GstSdp, GLib

import socket
import json
import sys
import os
import threading
import base64
import struct

# KLV PIDs to extract
KLV_PIDS = {0x0042, 0x0044, 0x0100, 0x0101, 0x0102, 0x01f1, 0x1000}

class WebRTCPipeline:
    def __init__(self, ipc_path: str):
        Gst.init(None)
        self.pipeline = None
        self.tee = None
        self.encoder = None
        self.input_bin = None
        self.valve = None
        self.rtppay = None
        self.clients = {}  # client_id -> { 'webrtcbin': element, 'queue': element, 'tee_pad': pad }
        self.ipc_path = ipc_path
        self.ipc_socket = None
        self.ipc_conn = None
        self.running = False
        self.loop = None
        self.current_source = None
        self.current_codec = 'h264'

        # TS buffer for KLV extraction
        self.ts_buffer = b''
        self.pes_buffers = {}  # PID -> accumulated PES data

        # For dynamic ghost pad linking
        self._decoder = None
        self._ghost_pad = None

    def _log(self, msg):
        print(f"[GStreamer] {msg}", flush=True)

    def _send_ipc(self, msg: dict):
        """Send message to Node.js via IPC socket."""
        if self.ipc_conn:
            try:
                data = json.dumps(msg) + "\n"
                self.ipc_conn.sendall(data.encode())
            except Exception as e:
                self._log(f"IPC send error: {e}")

    def _connect_ipc(self):
        """Connect to Node.js IPC server."""
        self.ipc_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.ipc_socket.connect(self.ipc_path)
            self.ipc_conn = self.ipc_socket
            self._log(f"Connected to IPC: {self.ipc_path}")

            # Start IPC receiver thread
            threading.Thread(target=self._ipc_receiver, daemon=True).start()
            return True
        except Exception as e:
            self._log(f"IPC connection failed: {e}")
            return False

    def _ipc_receiver(self):
        """Receive messages from Node.js."""
        buffer = ""
        while self.running:
            try:
                data = self.ipc_conn.recv(4096)
                if not data:
                    break
                buffer += data.decode()
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    if line.strip():
                        msg = json.loads(line)
                        GLib.idle_add(self._handle_ipc_message, msg)
            except Exception as e:
                self._log(f"IPC receive error: {e}")
                break

    def _handle_ipc_message(self, msg):
        """Handle message from Node.js (runs in main thread)."""
        msg_type = msg.get('type')

        if msg_type == 'start':
            self.start_pipeline(
                msg.get('source_type', 'udp'),
                msg.get('source_config', {})
            )
        elif msg_type == 'add_client':
            self.add_client(msg['client_id'])
        elif msg_type == 'remove_client':
            self.remove_client(msg['client_id'])
        elif msg_type == 'set_answer':
            self.set_remote_description(msg['client_id'], 'answer', msg['sdp'])
        elif msg_type == 'add_ice_candidate':
            self.add_ice_candidate(
                msg['client_id'],
                msg['candidate'],
                msg.get('sdp_mline_index', 0)
            )
        elif msg_type == 'hot_swap':
            self.hot_swap(
                msg.get('source_type', 'udp'),
                msg.get('source_config', {})
            )
        elif msg_type == 'stop':
            self.stop()

        return False  # Remove from idle

    def _create_input_bin(self, source_type: str, config: dict) -> Gst.Bin:
        """Create input bin based on source type."""
        bin = Gst.Bin.new("input-bin")

        if source_type == 'udp':
            port = config.get('port', 5000)
            codec = config.get('codec', 'h264')
            self.current_codec = codec

            # Simple pipeline: udpsrc -> tsparse -> tsdemux -> decoder
            udpsrc = Gst.ElementFactory.make("udpsrc", "udpsrc")
            udpsrc.set_property("port", port)
            udpsrc.set_property("buffer-size", 8388608)  # 8MB

            queue = Gst.ElementFactory.make("queue", "input-queue")
            queue.set_property("max-size-buffers", 200)
            queue.set_property("leaky", 2)

            tsparse = Gst.ElementFactory.make("tsparse", "tsparse")
            tsparse.set_property("set-timestamps", True)

            tsdemux = Gst.ElementFactory.make("tsdemux", "tsdemux")
            tsdemux.set_property("ignore-pcr", True)

            # Decoder based on codec
            if codec == 'mpeg2':
                decoder = Gst.ElementFactory.make("avdec_mpeg2video", "decoder")
            else:
                decoder = Gst.ElementFactory.make("avdec_h264", "decoder")
                decoder.set_property("output-corrupt", True)

            # Add elements
            for elem in [udpsrc, queue, tsparse, tsdemux, decoder]:
                bin.add(elem)

            # Link
            udpsrc.link(queue)
            queue.link(tsparse)
            tsparse.link(tsdemux)

            # Handle tsdemux dynamic pads
            tsdemux.connect("pad-added", self._on_demux_pad_added, decoder)

            # Create ghost pad - we need to wait for decoder to be linked
            # Use a template pad for now
            ghost = Gst.GhostPad.new_no_target("src", Gst.PadDirection.SRC)
            bin.add_pad(ghost)

            # Store decoder ref for later ghost pad linking
            self._decoder = decoder
            self._ghost_pad = ghost

        return bin

    def _on_demux_pad_added(self, demux, pad, decoder):
        """Handle tsdemux dynamic pads."""
        pad_name = pad.get_name()
        if pad_name.startswith("video"):
            sink_pad = decoder.get_static_pad("sink")
            if not sink_pad.is_linked():
                pad.link(sink_pad)
                self._log(f"Linked demux pad: {pad_name}")

                # Now set the ghost pad target to decoder src
                decoder_src = decoder.get_static_pad("src")
                if self._ghost_pad and decoder_src:
                    self._ghost_pad.set_target(decoder_src)
                    self._log("Ghost pad target set to decoder src")

    def _on_klv_sample(self, sink):
        """Handle KLV sample from appsink."""
        sample = sink.emit("pull-sample")
        if sample:
            buffer = sample.get_buffer()
            success, map_info = buffer.map(Gst.MapFlags.READ)
            if success:
                self._process_ts_for_klv(bytes(map_info.data))
                buffer.unmap(map_info)
        return Gst.FlowReturn.OK

    def _process_ts_for_klv(self, data: bytes):
        """Extract KLV from TS packets."""
        self.ts_buffer += data

        # Process complete TS packets (188 bytes each)
        while len(self.ts_buffer) >= 188:
            # Find sync byte
            if self.ts_buffer[0] != 0x47:
                # Resync
                idx = self.ts_buffer.find(b'\x47')
                if idx == -1:
                    self.ts_buffer = b''
                    return
                self.ts_buffer = self.ts_buffer[idx:]
                continue

            packet = self.ts_buffer[:188]
            self.ts_buffer = self.ts_buffer[188:]

            # Parse TS header
            pid = ((packet[1] & 0x1F) << 8) | packet[2]

            if pid not in KLV_PIDS:
                continue

            pusi = (packet[1] & 0x40) != 0  # Payload Unit Start Indicator
            adaptation = (packet[3] & 0x30) >> 4

            # Get payload offset
            payload_start = 4
            if adaptation in (2, 3):
                adaptation_length = packet[4]
                payload_start = 5 + adaptation_length

            if payload_start >= 188:
                continue

            payload = packet[payload_start:]

            # Handle PES assembly
            if pusi:
                # Check if we have accumulated data
                if pid in self.pes_buffers and len(self.pes_buffers[pid]) > 0:
                    self._extract_klv_from_pes(self.pes_buffers[pid])
                self.pes_buffers[pid] = payload
            else:
                if pid in self.pes_buffers:
                    self.pes_buffers[pid] += payload

                    # Limit buffer size
                    if len(self.pes_buffers[pid]) > 65536:
                        self.pes_buffers[pid] = b''

    def _extract_klv_from_pes(self, pes_data: bytes):
        """Extract KLV from PES packet."""
        if len(pes_data) < 9:
            return

        # Check PES start code
        if pes_data[0:3] != b'\x00\x00\x01':
            return

        # Get PES header length
        pes_header_len = 9 + pes_data[8] if len(pes_data) > 8 else 9

        if len(pes_data) <= pes_header_len:
            return

        klv_data = pes_data[pes_header_len:]

        # Check for SMPTE 336M UAS Local Set key
        if len(klv_data) >= 16:
            uas_key = bytes([0x06, 0x0E, 0x2B, 0x34, 0x02, 0x0B, 0x01, 0x01,
                            0x0E, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00])
            if klv_data[:16] == uas_key:
                # Send KLV to Node.js
                self._send_ipc({
                    'type': 'klv',
                    'data': base64.b64encode(klv_data).decode()
                })

    def start_pipeline(self, source_type: str, config: dict):
        """Start the pipeline with given source."""
        self._log(f"Starting pipeline: {source_type} {config}")

        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)

        port = config.get('port', 5000)
        codec = config.get('codec', 'h264')
        raw_input = config.get('raw', False)  # Raw RTP input from FrameBuffer -r
        vp8_input = config.get('vp8', False)  # VP8 RTP input from FrameBuffer -v
        self.current_codec = codec

        self.pipeline = Gst.Pipeline.new("webrtc-pipeline")

        # Common elements
        udpsrc = Gst.ElementFactory.make("udpsrc", "udpsrc")
        udpsrc.set_property("port", port)
        udpsrc.set_property("buffer-size", 8388608)

        queue1 = Gst.ElementFactory.make("queue", "queue1")
        queue1.set_property("max-size-buffers", 500)
        queue1.set_property("max-size-time", 2000000000)
        queue1.set_property("leaky", 2)

        # Video processing
        videoconvert = Gst.ElementFactory.make("videoconvert", "videoconvert")
        videoscale = Gst.ElementFactory.make("videoscale", "videoscale")

        capsfilter = Gst.ElementFactory.make("capsfilter", "capsfilter")
        caps = Gst.Caps.from_string("video/x-raw,width=640,height=480")
        capsfilter.set_property("caps", caps)

        queue3 = Gst.ElementFactory.make("queue", "queue3")
        queue3.set_property("max-size-buffers", 30)
        queue3.set_property("leaky", 2)

        self.encoder = Gst.ElementFactory.make("vp8enc", "encoder")
        self.encoder.set_property("deadline", 1)
        self.encoder.set_property("cpu-used", 8)
        self.encoder.set_property("target-bitrate", 1500000)
        self.encoder.set_property("keyframe-max-dist", 30)

        self.rtppay = Gst.ElementFactory.make("rtpvp8pay", "rtppay")
        self.rtppay.set_property("pt", 96)

        self.tee = Gst.ElementFactory.make("tee", "client-tee")
        self.tee.set_property("allow-not-linked", True)

        # VLC debug output
        vlc_queue = Gst.ElementFactory.make("queue", "vlc-queue")
        vlc_udpsink = Gst.ElementFactory.make("udpsink", "vlc-sink")
        vlc_udpsink.set_property("host", "127.0.0.1")
        vlc_udpsink.set_property("port", 5004)

        if vp8_input:
            # ===== VP8 RTP MODE =====
            # Direct VP8 RTP from FrameBuffer -v flag - zero encode in Python!
            # Pipeline: udpsrc -> rtpvp8depay -> rtpvp8pay -> webrtcbin
            self._log("Using VP8 RTP input mode (passthrough, no encode needed)")

            # Set caps for VP8 RTP
            rtp_caps = Gst.Caps.from_string(
                "application/x-rtp,media=video,encoding-name=VP8,clock-rate=90000,payload=96"
            )
            udpsrc.set_property("caps", rtp_caps)

            rtpvp8depay = Gst.ElementFactory.make("rtpvp8depay", "rtpvp8depay")

            # Add elements - note: we skip encoder since VP8 is already encoded
            for elem in [udpsrc, queue1, rtpvp8depay,
                         self.rtppay, self.tee,
                         vlc_queue, vlc_udpsink]:
                self.pipeline.add(elem)

            # Link: udpsrc -> queue -> rtpvp8depay -> rtpvp8pay -> tee
            udpsrc.link(queue1)
            queue1.link(rtpvp8depay)
            rtpvp8depay.link(self.rtppay)
            self.rtppay.link(self.tee)

        elif raw_input:
            # ===== RAW RTP MODE =====
            # Direct raw video from FrameBuffer -r flag
            # Pipeline: udpsrc -> rtpvrawdepay -> videoconvert -> vp8enc -> webrtcbin
            self._log("Using RAW RTP input mode (no decode needed)")

            # Set caps for raw RTP - must match FrameBuffer output format (I420 640x480)
            # FrameBuffer sends video/x-raw,format=I420 which becomes YCbCr-4:2:0 in RTP
            width = config.get('width', 640)
            height = config.get('height', 480)
            rtp_caps = Gst.Caps.from_string(
                f"application/x-rtp,media=video,encoding-name=RAW,clock-rate=90000,"
                f"sampling=YCbCr-4:2:0,depth=(string)8,width=(string){width},height=(string){height}"
            )
            udpsrc.set_property("caps", rtp_caps)

            rtpvrawdepay = Gst.ElementFactory.make("rtpvrawdepay", "rtpvrawdepay")

            # Add elements
            for elem in [udpsrc, queue1, rtpvrawdepay,
                         videoconvert, videoscale, capsfilter, queue3,
                         self.encoder, self.rtppay, self.tee,
                         vlc_queue, vlc_udpsink]:
                self.pipeline.add(elem)

            # Link: udpsrc -> queue -> rtpvrawdepay -> videoconvert -> ... -> tee
            udpsrc.link(queue1)
            queue1.link(rtpvrawdepay)
            rtpvrawdepay.link(videoconvert)
            videoconvert.link(videoscale)
            videoscale.link(capsfilter)
            capsfilter.link(queue3)
            queue3.link(self.encoder)
            self.encoder.link(self.rtppay)
            self.rtppay.link(self.tee)

        else:
            # ===== H.264 MPEG-TS MODE (default) =====
            # Pipeline: udpsrc -> tsdemux -> h264parse -> decoder -> vp8enc -> webrtcbin
            self._log("Using H.264 MPEG-TS input mode")

            tsparse = Gst.ElementFactory.make("tsparse", "tsparse")
            tsparse.set_property("set-timestamps", True)

            tsdemux = Gst.ElementFactory.make("tsdemux", "tsdemux")
            tsdemux.set_property("ignore-pcr", True)

            h264parse = Gst.ElementFactory.make("h264parse", "h264parse")
            decoder = Gst.ElementFactory.make("avdec_h264", "decoder")
            decoder.set_property("output-corrupt", True)

            # Add elements
            for elem in [udpsrc, queue1, tsparse, tsdemux, h264parse, decoder,
                         videoconvert, videoscale, capsfilter, queue3,
                         self.encoder, self.rtppay, self.tee,
                         vlc_queue, vlc_udpsink]:
                self.pipeline.add(elem)

            # Link static elements before tsdemux
            udpsrc.link(queue1)
            queue1.link(tsparse)
            tsparse.link(tsdemux)

            # Link static elements after decoder
            h264parse.link(decoder)
            decoder.link(videoconvert)
            videoconvert.link(videoscale)
            videoscale.link(capsfilter)
            capsfilter.link(queue3)
            queue3.link(self.encoder)
            self.encoder.link(self.rtppay)
            self.rtppay.link(self.tee)

            # Handle tsdemux dynamic pads
            def on_demux_pad_added(demux, pad):
                pad_name = pad.get_name()
                caps = pad.get_current_caps()
                if caps:
                    struct = caps.get_structure(0)
                    media_type = struct.get_name()
                    self._log(f"tsdemux pad: {pad_name} type: {media_type}")

                    if media_type.startswith("video/x-h264"):
                        sink_pad = h264parse.get_static_pad("sink")
                        if not sink_pad.is_linked():
                            ret = pad.link(sink_pad)
                            self._log(f"Linked tsdemux -> h264parse: {ret}")

            tsdemux.connect("pad-added", on_demux_pad_added)

        # Link VLC debug output from tee
        tee_vlc_pad = self.tee.request_pad_simple("src_%u")
        vlc_queue_sink = vlc_queue.get_static_pad("sink")
        tee_vlc_pad.link(vlc_queue_sink)
        vlc_queue.link(vlc_udpsink)
        self._log("VLC debug output enabled on rtp://127.0.0.1:5004")

        # Add probe to monitor data flow
        self._buffer_count = 0
        def tee_probe(pad, info):
            self._buffer_count += 1
            if self._buffer_count % 100 == 1:
                self._log(f"Data flowing: buffer #{self._buffer_count}")
            return Gst.PadProbeReturn.OK
        tee_sink = self.tee.get_static_pad("sink")
        if tee_sink:
            tee_sink.add_probe(Gst.PadProbeType.BUFFER, tee_probe)

        # Bus for errors
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect("message::error", self._on_error)
        bus.connect("message::eos", self._on_eos)
        bus.connect("message::state-changed", self._on_state_changed)

        # Start pipeline - don't block on state change since tsdemux has dynamic pads
        ret = self.pipeline.set_state(Gst.State.PLAYING)
        self._log(f"Pipeline set_state returned: {ret}")
        # Don't wait for state - dynamic pads from tsdemux will link asynchronously

        self.current_source = config

        self._send_ipc({'type': 'pipeline_started'})

    def _on_error(self, bus, msg):
        err, debug = msg.parse_error()
        self._log(f"Error: {err.message}")
        self._log(f"Debug: {debug}")
        self._send_ipc({
            'type': 'error',
            'message': err.message
        })

    def _on_eos(self, bus, msg):
        self._log("End of stream")
        self._send_ipc({'type': 'eos'})

    def _on_state_changed(self, bus, msg):
        if msg.src == self.pipeline:
            old, new, pending = msg.parse_state_changed()
            self._log(f"Pipeline state: {old.value_nick} -> {new.value_nick}")

    def add_client(self, client_id: str):
        """Add a new WebRTC client."""
        self._log(f"Adding client: {client_id}")

        if not self.pipeline or not self.tee:
            self._log(f"Pipeline not ready (pipeline={self.pipeline is not None}, tee={self.tee is not None})")
            return

        # Check pipeline state
        state = self.pipeline.get_state(0)
        self._log(f"Pipeline state before adding client: {state[1].value_nick}")

        # Create queue for this client
        queue = Gst.ElementFactory.make("queue", f"queue-{client_id}")
        queue.set_property("leaky", 2)
        queue.set_property("max-size-buffers", 10)

        # Create webrtcbin
        webrtcbin = Gst.ElementFactory.make("webrtcbin", f"webrtc-{client_id}")
        webrtcbin.set_property("bundle-policy", 3)  # max-bundle
        webrtcbin.set_property("stun-server", "stun://stun.l.google.com:19302")

        # Connect signals
        webrtcbin.connect("on-negotiation-needed", self._on_negotiation_needed, client_id)
        webrtcbin.connect("on-ice-candidate", self._on_ice_candidate, client_id)
        webrtcbin.connect("notify::ice-connection-state", self._on_ice_state, client_id)

        # Add to pipeline
        self.pipeline.add(queue)
        self.pipeline.add(webrtcbin)

        # Request tee pad
        tee_pad = self.tee.request_pad_simple("src_%u")
        queue_sink = queue.get_static_pad("sink")
        tee_pad.link(queue_sink)

        # Get RTP caps from rtppay
        rtp_caps = self.rtppay.get_static_pad("src").get_current_caps()
        if not rtp_caps:
            rtp_caps = Gst.Caps.from_string(
                "application/x-rtp,media=video,encoding-name=VP8,payload=96,clock-rate=90000"
            )

        # Request webrtcbin sink pad with caps
        webrtc_sink = webrtcbin.request_pad_simple("sink_%u")

        # Link queue to webrtcbin
        queue_src = queue.get_static_pad("src")
        queue_src.link(webrtc_sink)

        # Sync states
        queue.sync_state_with_parent()
        webrtcbin.sync_state_with_parent()

        self.clients[client_id] = {
            'webrtcbin': webrtcbin,
            'queue': queue,
            'tee_pad': tee_pad
        }

        self._log(f"Client {client_id} added, total: {len(self.clients)}")

        # Force negotiation for clients added to running pipeline
        GLib.idle_add(self._force_negotiation, client_id, webrtcbin)

    def remove_client(self, client_id: str):
        """Remove a WebRTC client."""
        if client_id not in self.clients:
            return

        self._log(f"Removing client: {client_id}")
        client = self.clients[client_id]

        # Unlink and remove
        self.tee.release_request_pad(client['tee_pad'])
        client['queue'].set_state(Gst.State.NULL)
        client['webrtcbin'].set_state(Gst.State.NULL)
        self.pipeline.remove(client['queue'])
        self.pipeline.remove(client['webrtcbin'])

        del self.clients[client_id]
        self._log(f"Client {client_id} removed, remaining: {len(self.clients)}")

    def set_remote_description(self, client_id: str, sdp_type: str, sdp: str):
        """Set remote SDP (answer from browser)."""
        if client_id not in self.clients:
            self._log(f"Client not found: {client_id}")
            return

        self._log(f"Setting remote description for {client_id}")
        webrtcbin = self.clients[client_id]['webrtcbin']

        res, sdp_msg = GstSdp.SDPMessage.new_from_text(sdp)
        if res != GstSdp.SDPResult.OK:
            self._log(f"Failed to parse SDP: {res}")
            return

        if sdp_type == "answer":
            answer = GstWebRTC.WebRTCSessionDescription.new(
                GstWebRTC.WebRTCSDPType.ANSWER, sdp_msg
            )
            promise = Gst.Promise.new()
            webrtcbin.emit("set-remote-description", answer, promise)
            promise.wait()
            self._log(f"Remote description set for {client_id}")

    def add_ice_candidate(self, client_id: str, candidate: str, sdp_mline_index: int):
        """Add ICE candidate from browser."""
        if client_id not in self.clients:
            return

        webrtcbin = self.clients[client_id]['webrtcbin']
        webrtcbin.emit("add-ice-candidate", sdp_mline_index, candidate)

    def _force_negotiation(self, client_id, webrtcbin):
        """Force negotiation for clients added to running pipeline."""
        if client_id not in self.clients:
            return False
        self._log(f"Forcing negotiation for {client_id}")
        self._on_negotiation_needed(webrtcbin, client_id)
        return False  # Don't repeat

    def _on_negotiation_needed(self, webrtcbin, client_id):
        """Create offer when negotiation needed."""
        self._log(f"Negotiation needed for {client_id}")

        # Create offer synchronously
        promise = Gst.Promise.new()
        webrtcbin.emit("create-offer", None, promise)

        # Wait for promise and handle in idle callback to avoid blocking
        GLib.idle_add(self._handle_offer_promise, promise, client_id, webrtcbin)

    def _handle_offer_promise(self, promise, client_id, webrtcbin):
        """Handle offer creation result."""
        # Wait for the promise
        promise.wait()

        if client_id not in self.clients:
            return False

        reply = promise.get_reply()
        if not reply:
            self._log(f"No reply for offer creation")
            return False

        offer = reply.get_value("offer")
        if not offer:
            self._log(f"No offer in reply")
            return False

        # Set local description
        promise2 = Gst.Promise.new()
        webrtcbin.emit("set-local-description", offer, promise2)
        promise2.wait()

        # Send offer to Node.js
        sdp_text = offer.sdp.as_text()
        self._log(f"Sending offer for {client_id}")
        self._send_ipc({
            'type': 'offer',
            'client_id': client_id,
            'sdp': sdp_text
        })

        return False  # Don't repeat idle callback

    def _on_ice_candidate(self, webrtcbin, mline_index, candidate, client_id):
        """Handle new ICE candidate."""
        self._send_ipc({
            'type': 'ice_candidate',
            'client_id': client_id,
            'candidate': candidate,
            'sdp_mline_index': mline_index
        })

    def _on_ice_state(self, webrtcbin, pspec, client_id):
        """Handle ICE connection state changes."""
        state = webrtcbin.get_property("ice-connection-state")
        self._log(f"ICE state for {client_id}: {state}")

        if state == GstWebRTC.WebRTCICEConnectionState.CONNECTED:
            self._send_ipc({
                'type': 'client_connected',
                'client_id': client_id
            })
        elif state == GstWebRTC.WebRTCICEConnectionState.FAILED:
            self._send_ipc({
                'type': 'client_failed',
                'client_id': client_id
            })

    def hot_swap(self, source_type: str, config: dict):
        """Hot-swap the input source - just request keyframe, don't restart pipeline.

        Since the UDP port is the same, the pipeline continues receiving from the new source.
        We just need to request a keyframe to resync the decoder.
        """
        self._log(f"Hot-swap to: {source_type} {config}")

        if not self.pipeline:
            self._log("No pipeline to hot-swap")
            return

        # Same port = same UDP socket, pipeline keeps running
        # Just request a keyframe after a short delay for decoder resync
        self._log(f"Hot-swap: keeping pipeline, requesting keyframe")

        # Wait for new source to start sending, then request keyframe
        GLib.timeout_add(1000, self._request_keyframe_after_hotswap)

        self._send_ipc({'type': 'hot_swap_complete'})

    def _request_keyframe_after_hotswap(self):
        """Request keyframe after hot-swap to resync decoder."""
        if self.encoder:
            self._log("Requesting keyframe after hot-swap")
            structure = Gst.Structure.new_empty("GstForceKeyUnit")
            event = Gst.Event.new_custom(Gst.EventType.CUSTOM_UPSTREAM, structure)
            self.encoder.send_event(event)
        return False

    def _readd_clients_after_hotswap(self, saved_clients):
        """Re-add clients after hot-swap delay."""
        if not self.pipeline or not self.tee:
            self._log("Pipeline not ready after hot-swap delay, aborting")
            return False

        # Check pipeline is playing
        ret, state, pending = self.pipeline.get_state(0)
        if state != Gst.State.PLAYING:
            self._log(f"Pipeline not playing yet ({state.value_nick}), waiting...")
            return True  # Try again

        # Re-add all clients
        for client_id in saved_clients:
            self._log(f"Re-adding client {client_id} after hot-swap")
            self.add_client(client_id)

        self._send_ipc({'type': 'hot_swap_complete'})
        return False  # Don't repeat

    def _open_valve_and_keyframe(self):
        """Open valve and request keyframe."""
        self.valve.set_property("drop", False)

        # Request keyframe
        structure = Gst.Structure.new_empty("GstForceKeyUnit")
        event = Gst.Event.new_custom(Gst.EventType.CUSTOM_UPSTREAM, structure)
        self.encoder.send_event(event)

        self._log("Valve opened, keyframe requested")
        return False

    def stop(self):
        """Stop the pipeline."""
        self._log("Stopping pipeline")

        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
            self.pipeline = None

        self.clients.clear()
        self._send_ipc({'type': 'stopped'})

    def run(self):
        """Run the main loop."""
        self.running = True

        # Connect to IPC
        if not self._connect_ipc():
            self._log("Failed to connect IPC, exiting")
            return

        # Run GLib main loop
        self.loop = GLib.MainLoop()
        try:
            self._log("Entering main loop")
            self.loop.run()
        except KeyboardInterrupt:
            pass
        finally:
            self.running = False
            self.stop()
            if self.ipc_socket:
                self.ipc_socket.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: webrtc_pipeline.py <ipc_socket_path>")
        sys.exit(1)

    ipc_path = sys.argv[1]
    pipeline = WebRTCPipeline(ipc_path)
    pipeline.run()
