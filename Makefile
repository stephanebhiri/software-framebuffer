# SoftwareFrameBuffer - Ultra-stable video frame synchronizer
# Makefile for macOS (Apple Silicon) and Linux

CC = gcc
CFLAGS = -O3 -Wall

# Platform-specific optimizations
UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)

ifeq ($(UNAME_S),Darwin)
    ifeq ($(UNAME_M),arm64)
        CFLAGS += -mcpu=apple-m1 -mtune=apple-m1
    else
        CFLAGS += -march=native
    endif
endif

ifeq ($(UNAME_S),Linux)
    CFLAGS += -march=native
endif

LIBS = $(shell pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0 gstreamer-video-1.0 glib-2.0)

TARGET = framebuffer
SRC = framebuffer.c

.PHONY: all clean run install

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) -o $(TARGET) $(SRC) $(LIBS)

clean:
	rm -f $(TARGET)

run: $(TARGET)
	./$(TARGET)

install: $(TARGET)
	cp $(TARGET) /usr/local/bin/
