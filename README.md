# SoftwareFrameBuffer

**Ultra-stable video frame synchronizer with decoupled input/output.**
Converts chaotic UDP MPEG-TS input into a **rock-solid, timing-perfect output stream**, with automatic codec detection and seamless source switching.

SoftwareFrameBuffer is a **render-loop based frame synchronizer** designed for unreliable IP video sources (drones, field encoders, simulations, ISR feeds) that require continuous, stable output regardless of input behavior.

---

## Key Features

- **Decoupled Input/Output Architecture**
  Input receives frames whenever they arrive (chaotic). Output renders at exact fps (rock-solid).

- **1-Second Jitter Buffer**
  Absorbs UDP jitter and network bursts before decoding.

- **Automatic Codec Detection**
  Uses `decodebin3` to handle H.264, H.265, MPEG-2, VP8, VP9 without configuration.

- **Seamless Source Switching**
  Switch between sources mid-stream without restarting. Uses pad-probe blocking for safe transitions.

- **Frame Repeat on Starvation**
  When input stalls, the last good frame is repeated. Never drops output frames.

- **Multiple Output Modes**
  Shared memory (for IPC), VP8 RTP (WebRTC-ready), Raw RTP, or H.264 MPEG-TS.

- **GStreamer Clock Timing**
  Uses `GstClock` for precise frame scheduling — not `usleep()` approximations.

---

## What This Is (and Is Not)

### What SoftwareFrameBuffer Does
- Stabilizes chaotic IP video inputs into continuous output
- Guarantees exact output framerate regardless of input timing
- Survives source changes, codec switches, and input stalls
- Behaves like a **camera filming a cinema screen** — output is always stable

### What SoftwareFrameBuffer Does Not Do
- It does **not** provide genlock or phase-accurate clock regeneration
- It does **not** preserve original frame timing (it re-times everything)
- It does **not** replace hardware frame synchronizers

This project implements a **software render-loop frame synchronizer**, not a TBC device.

---

## Requirements

- macOS or Linux
- GStreamer **1.20+**
- GStreamer plugins: base, good, bad, ugly

### Install Dependencies (macOS)

```bash
brew install gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly gst-libav
```

### Install Dependencies (Ubuntu/Debian)

```bash
apt install libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev \
    gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly \
    gstreamer1.0-libav
```

---

## Build

```bash
make
```

---

## Usage

```
./framebuffer [options]

Input options:
  -i PORT     UDP input port (default: 5001)

Output options:
  -o PORT     UDP output port (default: 5002)
  -H HOST     Output host/IP (default: 127.0.0.1)
  -w WIDTH    Output width (default: 640)
  -h HEIGHT   Output height (default: 480)
  -f FPS      Output framerate (default: 25)
  -b KBPS     Encoder bitrate in kbps (default: 2000)

Output modes:
  (default)   H.264 MPEG-TS over UDP
  -r          Raw RTP video (no encoding)
  -v          VP8 RTP (WebRTC-ready)
  -s [PATH]   Shared memory output (default: /tmp/framebuffer.sock)

Other options:
  --help      Show this help
```

---

## Output Modes

| Mode | Flag | Description | Use Case |
|------|------|-------------|----------|
| H.264 MPEG-TS | (default) | Re-encoded H.264 in MPEG-TS container | Standard video distribution |
| Raw RTP | `-r` | Uncompressed video over RTP | Minimal latency, high bandwidth |
| VP8 RTP | `-v` | VP8 encoded, RTP payload | Direct WebRTC input |
| Shared Memory | `-s` | Raw frames via `shmsink` | IPC with WebRTC Gateway |

---

## Examples

### Default (640x480 @ 25fps, H.264 MPEG-TS output):
```bash
./framebuffer -i 5000
```

### HD output (1280x720 @ 30fps):
```bash
./framebuffer -i 5000 -w 1280 -h 720 -f 30 -b 4000
```

### Shared memory for WebRTC Gateway:
```bash
./framebuffer -i 5000 -s /tmp/framebuffer.sock -w 640 -h 480 -f 30
```

### VP8 RTP for direct WebRTC:
```bash
./framebuffer -i 5000 -v -o 5004
```

---

## Testing

### Send a test stream (any codec):

```bash
# H.264
ffmpeg -re -stream_loop -1 -i video.ts -c copy -f mpegts "udp://127.0.0.1:5001"

# MPEG-2
ffmpeg -re -stream_loop -1 -i mpeg2_video.mpg -c copy -f mpegts "udp://127.0.0.1:5001"
```

### Receive the output:

**MPEG-TS format** (default):
```bash
ffplay udp://127.0.0.1:5002
vlc udp://@:5002
```

**Shared memory** (requires shmsrc consumer):
```bash
gst-launch-1.0 shmsrc socket-path=/tmp/framebuffer.sock ! \
    video/x-raw,format=I420,width=640,height=480,framerate=30/1 ! \
    videoconvert ! autovideosink
```

---

## Architecture Overview

```
UDP MPEG-TS (chaotic input, any codec)
        |
   [udpsrc port=5001 buffer-size=64MB]
        |
   [queue min-threshold-time=1s]     <-- JITTER BUFFER (key!)
        |
   [tsparse]
        |
   [decodebin3]                      <-- Auto codec: H.264, MPEG2, etc.
        |
   [videoconvert] -> [videoscale]
        |
   [capsfilter: I420 WxH]
        |
   [appsink]
        |
        v
+------------------+
|   FRAME BUFFER   |  <-- Single frame, mutex protected
|  current_frame   |
+------------------+
        |
        v
+------------------+
|   RENDER LOOP    |  <-- Dedicated thread, GstClock timing
|                  |
|  while(running): |
|    frame = copy(current_frame) ?: gray
|    push(appsrc, frame, pts)
|    wait_until(next_frame_time)
+------------------+
        |
   [appsrc]
        |
   [shmsink / vp8enc / x264enc]
        |
   Stable output (exact fps)
```

---

## How It Works

1. **Reception & Buffering**
   UDP MPEG-TS is received with a 64MB socket buffer. A 1-second queue absorbs jitter before any processing begins.

2. **Demux & Decode**
   `tsparse` extracts elementary streams. `decodebin3` automatically selects the appropriate decoder (H.264, MPEG-2, etc.).

3. **Normalization**
   `videoconvert` and `videoscale` normalize to I420 at configured resolution.

4. **Frame Capture**
   `appsink` captures decoded frames into a single-frame buffer protected by mutex.

5. **Render Loop**
   A dedicated thread runs at exactly the configured fps using `GstClock`. Each iteration:
   - Copies the current frame (or creates gray fallback if none)
   - Sets proper PTS/DTS timestamps
   - Pushes to output pipeline
   - Waits for precise next-frame time

6. **Stable Output**
   The output pipeline receives frames at rock-solid timing, regardless of input chaos.

---

## Seamless Source Switching

When a new source appears (different codec, resolution, etc.):

1. `tsdemux` detects new pad with different caps
2. Pad probe blocks the decoder sink pad
3. Old source is unlinked
4. New source is linked
5. Probe removed, dataflow resumes
6. `decodebin3` handles the codec change automatically

The render loop never stops — it keeps pushing frames throughout the transition.

---

## Supported Input Codecs

| Codec | Decoder | Notes |
|-------|---------|-------|
| H.264 / AVC | avdec_h264, vtdec | Software or hardware |
| H.265 / HEVC | avdec_h265, vtdec | Software or hardware |
| MPEG-2 | mpeg2dec, avdec_mpeg2video | libmpeg2 preferred |
| VP8 | vp8dec | Software |
| VP9 | vp9dec | Software |

---

## Stats Output

Every 5 seconds, stats are printed:

```
[FrameBuffer] Stats: in=750 out=750 repeated=0
[FrameBuffer] Stats: in=1500 out=1500 repeated=12
```

- `in`: Frames received from decoder
- `out`: Frames pushed to output
- `repeated`: Frames where input stalled (same frame pushed twice)

---

## Integration with WebRTC Gateway

The shared memory mode (`-s`) is designed for seamless integration:

```
┌────────────┐     shmsink      ┌─────────────────┐
│FrameBuffer │ ──────────────── │ WebRTC Gateway  │
│  (decode)  │  /tmp/fb.sock    │ (VP8 + WebRTC)  │
└────────────┘                  └─────────────────┘
      │                                │
   Restarts                     Stays connected
   on source                    (no reconnection
    change                        needed!)
```

---

## Performance

Typical performance on Apple Silicon M1/M2/M3:

- **Decode**: Software (avdec) or hardware (vtdec)
- **Encode**: Software (x264enc, vp8enc) or hardware
- **CPU usage**: ~20-40% for 1080p
- **Latency**: ~1s (jitter buffer) + encoding latency
- **Memory**: ~50-100MB

---

## License

MIT License

---

## Author

Stephane Bhiri
