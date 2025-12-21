# FrameBuffer - Video Frame Synchronizer
# Build with: make

CC = gcc
CFLAGS = -Wall -O2 $(shell pkg-config --cflags gstreamer-1.0 gstreamer-app-1.0)
LDFLAGS = $(shell pkg-config --libs gstreamer-1.0 gstreamer-app-1.0)

TARGET = framebuffer
SRC = framebuffer.c

# Output directory
BINDIR = ../../bin

all: $(BINDIR)/$(TARGET)

$(BINDIR)/$(TARGET): $(SRC)
	@mkdir -p $(BINDIR)
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)
	@echo "Built: $@"

clean:
	rm -f $(BINDIR)/$(TARGET)

test: $(BINDIR)/$(TARGET)
	@echo "Testing framebuffer..."
	@echo "1. Start: $(BINDIR)/$(TARGET) -i 5001 -o 5002"
	@echo "2. Send video to UDP port 5001"
	@echo "3. Receive from UDP port 5002"

.PHONY: all clean test
