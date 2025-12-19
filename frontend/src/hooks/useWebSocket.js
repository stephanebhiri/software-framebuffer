import { useState, useEffect, useCallback, useRef } from 'react';
import * as mediasoupClient from 'mediasoup-client';

const WS_URL = 'ws://localhost:3001';

export function useWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [klvData, setKlvData] = useState(null);
  const [status, setStatus] = useState({ streaming: false, source: null, mode: null });
  const [hlsUrl, setHlsUrl] = useState(null);
  const [webrtcStream, setWebrtcStream] = useState(null);
  const [clientId, setClientId] = useState(null);

  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const deviceRef = useRef(null);
  const transportRef = useRef(null);
  const consumerRef = useRef(null);
  const pendingResolvers = useRef({});

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  // Wait for a specific message type
  const waitForMessage = useCallback((type) => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        delete pendingResolvers.current[type];
        reject(new Error(`Timeout waiting for ${type}`));
      }, 10000);

      pendingResolvers.current[type] = (data) => {
        clearTimeout(timeout);
        resolve(data);
      };
    });
  }, []);

  // Initialize mediasoup device
  const initWebRTC = useCallback(async (rtpCapabilities) => {
    console.log('Initializing WebRTC device...');

    try {
      // Create device
      const device = new mediasoupClient.Device();
      await device.load({ routerRtpCapabilities: rtpCapabilities });
      deviceRef.current = device;
      console.log('Device loaded');

      // Request transport creation
      send({ type: 'webrtc-create-transport' });
      const { transportParams } = await waitForMessage('webrtc-transport-created');
      console.log('Transport params received:', transportParams.id);

      // Create receive transport
      const transport = device.createRecvTransport(transportParams);
      transportRef.current = transport;

      transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
        try {
          send({ type: 'webrtc-connect-transport', dtlsParameters });
          await waitForMessage('webrtc-transport-connected');
          callback();
        } catch (error) {
          errback(error);
        }
      });

      transport.on('connectionstatechange', (state) => {
        console.log('Transport connection state:', state);
        if (state === 'failed' || state === 'closed') {
          cleanupWebRTC();
        }
      });

      // Request consumer creation
      send({
        type: 'webrtc-consume',
        rtpCapabilities: device.rtpCapabilities
      });
      const { consumerParams } = await waitForMessage('webrtc-consumer-created');
      console.log('Consumer params received:', consumerParams.id);

      // Create consumer
      const consumer = await transport.consume({
        id: consumerParams.id,
        producerId: consumerParams.producerId,
        kind: consumerParams.kind,
        rtpParameters: consumerParams.rtpParameters
      });
      consumerRef.current = consumer;

      // Create MediaStream from consumer track
      const stream = new MediaStream([consumer.track]);
      setWebrtcStream(stream);
      console.log('WebRTC stream created');

      // Resume consumer
      send({ type: 'webrtc-resume' });

    } catch (error) {
      console.error('WebRTC initialization failed:', error);
    }
  }, [send, waitForMessage]);

  const cleanupWebRTC = useCallback(() => {
    if (consumerRef.current) {
      consumerRef.current.close();
      consumerRef.current = null;
    }
    if (transportRef.current) {
      transportRef.current.close();
      transportRef.current = null;
    }
    deviceRef.current = null;
    setWebrtcStream(null);
  }, []);

  const handleMessage = useCallback((message) => {
    // Check for pending resolvers first
    if (pendingResolvers.current[message.type]) {
      pendingResolvers.current[message.type](message);
      delete pendingResolvers.current[message.type];
      return;
    }

    switch (message.type) {
      case 'status':
        setClientId(message.clientId);
        setStatus({
          streaming: message.streaming,
          source: message.source,
          mode: message.mode
        });
        if (message.hlsUrl) {
          setHlsUrl(`http://localhost:3001${message.hlsUrl}`);
        } else {
          setHlsUrl(null);
        }
        // Initialize WebRTC if UDP stream is active
        if (message.webrtc && message.rtpCapabilities && !webrtcStream) {
          initWebRTC(message.rtpCapabilities);
        }
        break;

      case 'klv':
        setKlvData(message.data);
        break;

      case 'stream-started':
        setStatus({
          streaming: true,
          source: message.source,
          mode: message.mode
        });
        if (message.hlsUrl) {
          setHlsUrl(`http://localhost:3001${message.hlsUrl}`);
        }
        // Initialize WebRTC if available
        if (message.webrtc && message.rtpCapabilities) {
          initWebRTC(message.rtpCapabilities);
        }
        break;

      case 'stream-stopped':
        setStatus({ streaming: false, source: null, mode: null });
        setHlsUrl(null);
        setKlvData(null);
        cleanupWebRTC();
        break;

      case 'stream-ended':
        setStatus(prev => ({ ...prev, streaming: false }));
        cleanupWebRTC();
        break;

      case 'error':
        console.error('Server error:', message.message);
        break;
    }
  }, [initWebRTC, cleanupWebRTC]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('WebSocket connected');
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleMessage(message);
      } catch (e) {
        console.error('Failed to parse message:', e);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setIsConnected(false);
      cleanupWebRTC();
      reconnectTimeoutRef.current = setTimeout(connect, 2000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    wsRef.current = ws;
  }, [handleMessage, cleanupWebRTC]);

  const startStream = useCallback((file) => {
    send({ type: 'start', file });
  }, [send]);

  const startUDP = useCallback((port) => {
    send({ type: 'start-udp', port });
  }, [send]);

  const stopStream = useCallback(() => {
    send({ type: 'stop' });
    cleanupWebRTC();
  }, [send, cleanupWebRTC]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      cleanupWebRTC();
      wsRef.current?.close();
    };
  }, [connect, cleanupWebRTC]);

  return {
    isConnected,
    klvData,
    status,
    hlsUrl,
    webrtcStream,
    clientId,
    startStream,
    startUDP,
    stopStream
  };
}
