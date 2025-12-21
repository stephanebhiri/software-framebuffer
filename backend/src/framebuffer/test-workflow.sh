#!/bin/bash
# FrameBuffer Test Workflow
# Tests source switching stability

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="$SCRIPT_DIR/../../bin"
SAMPLES_DIR="/Users/stephane/Documents/CV_Stephane_Bhiri/KLV_Display/samples/QGISFMV_Samples/MISB"

FRAMEBUFFER="$BIN_DIR/framebuffer"
INPUT_PORT=5001
OUTPUT_PORT=5002

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[TEST]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; }

cleanup() {
    log "Cleaning up..."
    pkill -f "framebuffer" 2>/dev/null || true
    pkill -f "ffmpeg.*udp://127.0.0.1:$INPUT_PORT" 2>/dev/null || true
    pkill -f "ffplay.*udp://127.0.0.1:$OUTPUT_PORT" 2>/dev/null || true
}

trap cleanup EXIT

# Build
log "Building framebuffer..."
cd "$SCRIPT_DIR"
make

if [ ! -x "$FRAMEBUFFER" ]; then
    err "Build failed!"
    exit 1
fi
log "Build OK"

# Check samples
if [ ! -f "$SAMPLES_DIR/Cheyenne.ts" ]; then
    err "Sample file not found: $SAMPLES_DIR/Cheyenne.ts"
    exit 1
fi

# Start framebuffer
log "Starting framebuffer..."
"$FRAMEBUFFER" -i $INPUT_PORT -o $OUTPUT_PORT -w 640 -h 480 -f 25 &
FB_PID=$!
sleep 2

if ! kill -0 $FB_PID 2>/dev/null; then
    err "Framebuffer failed to start"
    exit 1
fi
log "Framebuffer running (PID: $FB_PID)"

# Start output viewer (optional - comment out for headless)
# log "Starting output viewer..."
# ffplay -fflags nobuffer -flags low_delay -framedrop \
#     -i "udp://127.0.0.1:$OUTPUT_PORT" &

# Test 1: Start with Cheyenne
log "=== TEST 1: Start with Cheyenne ==="
ffmpeg -hide_banner -loglevel warning \
    -fflags +genpts+igndts -err_detect ignore_err \
    -re -stream_loop -1 -i "$SAMPLES_DIR/Cheyenne.ts" \
    -map 0:v -map 0:d? -c copy \
    -f mpegts "udp://127.0.0.1:$INPUT_PORT?pkt_size=1316" &
FFMPEG_PID=$!
log "Streaming Cheyenne (PID: $FFMPEG_PID)"
sleep 5

# Check framebuffer is receiving
if ! kill -0 $FB_PID 2>/dev/null; then
    err "Framebuffer crashed!"
    exit 1
fi
log "TEST 1 PASSED: Cheyenne streaming OK"

# Test 2: Switch to Falls
log "=== TEST 2: Switch to Falls ==="
kill $FFMPEG_PID 2>/dev/null || true
sleep 0.5

ffmpeg -hide_banner -loglevel warning \
    -fflags +genpts+igndts -err_detect ignore_err \
    -re -stream_loop -1 -i "$SAMPLES_DIR/falls.ts" \
    -map 0:v -map 0:d? -c copy \
    -f mpegts "udp://127.0.0.1:$INPUT_PORT?pkt_size=1316" &
FFMPEG_PID=$!
log "Streaming Falls (PID: $FFMPEG_PID)"
sleep 5

if ! kill -0 $FB_PID 2>/dev/null; then
    err "Framebuffer crashed after switch!"
    exit 1
fi
log "TEST 2 PASSED: Switch to Falls OK"

# Test 3: Switch back to Cheyenne
log "=== TEST 3: Switch back to Cheyenne ==="
kill $FFMPEG_PID 2>/dev/null || true
sleep 0.5

ffmpeg -hide_banner -loglevel warning \
    -fflags +genpts+igndts -err_detect ignore_err \
    -re -stream_loop -1 -i "$SAMPLES_DIR/Cheyenne.ts" \
    -map 0:v -map 0:d? -c copy \
    -f mpegts "udp://127.0.0.1:$INPUT_PORT?pkt_size=1316" &
FFMPEG_PID=$!
log "Streaming Cheyenne again (PID: $FFMPEG_PID)"
sleep 5

if ! kill -0 $FB_PID 2>/dev/null; then
    err "Framebuffer crashed after second switch!"
    exit 1
fi
log "TEST 3 PASSED: Switch back to Cheyenne OK"

# Test 4: Rapid switching (stress test)
log "=== TEST 4: Rapid switching (stress test) ==="
for i in {1..5}; do
    kill $FFMPEG_PID 2>/dev/null || true
    sleep 0.2

    if [ $((i % 2)) -eq 0 ]; then
        SRC="$SAMPLES_DIR/Cheyenne.ts"
        NAME="Cheyenne"
    else
        SRC="$SAMPLES_DIR/falls.ts"
        NAME="Falls"
    fi

    ffmpeg -hide_banner -loglevel warning \
        -fflags +genpts+igndts -err_detect ignore_err \
        -re -stream_loop -1 -i "$SRC" \
        -map 0:v -map 0:d? -c copy \
        -f mpegts "udp://127.0.0.1:$INPUT_PORT?pkt_size=1316" &
    FFMPEG_PID=$!
    log "  Switch $i: $NAME"
    sleep 2

    if ! kill -0 $FB_PID 2>/dev/null; then
        err "Framebuffer crashed during rapid switching!"
        exit 1
    fi
done
log "TEST 4 PASSED: Rapid switching OK"

# Test 5: Source dropout (no input for 3 seconds)
log "=== TEST 5: Source dropout ==="
kill $FFMPEG_PID 2>/dev/null || true
log "Stopped input, waiting 3 seconds..."
sleep 3

if ! kill -0 $FB_PID 2>/dev/null; then
    err "Framebuffer crashed during dropout!"
    exit 1
fi
log "TEST 5 PASSED: Survived source dropout"

# Resume
log "Resuming with Cheyenne..."
ffmpeg -hide_banner -loglevel warning \
    -fflags +genpts+igndts -err_detect ignore_err \
    -re -stream_loop -1 -i "$SAMPLES_DIR/Cheyenne.ts" \
    -map 0:v -map 0:d? -c copy \
    -f mpegts "udp://127.0.0.1:$INPUT_PORT?pkt_size=1316" &
FFMPEG_PID=$!
sleep 3

if ! kill -0 $FB_PID 2>/dev/null; then
    err "Framebuffer crashed after resume!"
    exit 1
fi

# Done
echo ""
log "========================================="
log "ALL TESTS PASSED!"
log "========================================="
echo ""
log "Framebuffer stats:"
kill -0 $FB_PID 2>/dev/null && log "  Still running: YES"

cleanup
