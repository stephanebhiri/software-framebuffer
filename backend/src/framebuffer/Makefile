# WebRTC Gateway - Build for KLV_Display
# NOTE: framebuffer binary comes from software-framebuffer repo (GitHub)
#       Only webrtc-gateway is built locally

CC = gcc

# WebRTC Gateway packages
WEBRTC_CFLAGS = -Wall -O2 $(shell pkg-config --cflags gstreamer-1.0 gstreamer-webrtc-1.0 gstreamer-sdp-1.0 json-glib-1.0)
WEBRTC_LDFLAGS = $(shell pkg-config --libs gstreamer-1.0 gstreamer-webrtc-1.0 gstreamer-sdp-1.0 json-glib-1.0)

WEBRTC_TARGET = webrtc-gateway
WEBRTC_SRC = webrtc-gateway.c

# Output directory
BINDIR = ../../bin

all: $(BINDIR)/$(WEBRTC_TARGET)

$(BINDIR)/$(WEBRTC_TARGET): $(WEBRTC_SRC)
	@mkdir -p $(BINDIR)
	$(CC) $(WEBRTC_CFLAGS) -o $@ $< $(WEBRTC_LDFLAGS)
	@echo "Built: $@"

clean:
	rm -f $(BINDIR)/$(WEBRTC_TARGET)

.PHONY: all clean
