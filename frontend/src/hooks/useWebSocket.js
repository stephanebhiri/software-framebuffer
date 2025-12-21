import { useState, useEffect, useCallback, useRef } from 'react';

const WS_URL = 'ws://localhost:3001';

// STUN servers for ICE
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

export function useWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [klvData, setKlvData] = useState(null);
  const [status, setStatus] = useState({ streaming: false, source: null, mode: null });
  const [hlsUrl, setHlsUrl] = useState(null);
  const [webrtcStream, setWebrtcStream] = useState(null);
  const [clientId, setClientId] = useState(null);

  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const pcRef = useRef(null);  // RTCPeerConnection
  const webrtcInitialized = useRef(false);

  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  // Initialize WebRTC with native RTCPeerConnection
  const initWebRTC = useCallback(() => {
    if (webrtcInitialized.current) {
      console.log('WebRTC already initialized');
      return;
    }

    console.log('Requesting WebRTC initialization...');
    webrtcInitialized.current = true;

    // Request server to add us as a client
    send({ type: 'webrtc-init' });
  }, [send]);

  // Handle SDP offer from server (via GStreamer webrtcbin)
  const handleOffer = useCallback(async (sdp) => {
    console.log('Received SDP offer from server');

    // Close existing connection if any (for hot-swap reconnection)
    if (pcRef.current) {
      console.log('Closing existing peer connection for new offer');
      pcRef.current.close();
      pcRef.current = null;
    }

    try {
      // Create peer connection
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;

      // Handle incoming tracks
      pc.ontrack = (event) => {
        console.log('Received track:', event.track.kind);
        const stream = new MediaStream([event.track]);
        setWebrtcStream(stream);
      };

      // Handle ICE candidates from our side
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          console.log('Sending ICE candidate to server');
          send({
            type: 'webrtc-ice-candidate',
            candidate: event.candidate.candidate,
            sdpMLineIndex: event.candidate.sdpMLineIndex
          });
        }
      };

      // Handle connection state changes
      pc.onconnectionstatechange = () => {
        console.log('Connection state:', pc.connectionState);
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          cleanupWebRTC();
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', pc.iceConnectionState);
      };

      // Set remote description (the offer from GStreamer)
      await pc.setRemoteDescription(new RTCSessionDescription({
        type: 'offer',
        sdp: sdp
      }));
      console.log('Remote description set');

      // Create and set local description (our answer)
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log('Local description set');

      // Send answer to server
      send({
        type: 'webrtc-answer',
        sdp: answer.sdp
      });
      console.log('Sent SDP answer to server');

    } catch (error) {
      console.error('Failed to handle offer:', error);
      cleanupWebRTC();
    }
  }, [send]);

  // Handle ICE candidate from server
  const handleIceCandidate = useCallback(async (candidate, sdpMLineIndex) => {
    if (!pcRef.current) {
      console.warn('No peer connection for ICE candidate');
      return;
    }

    try {
      await pcRef.current.addIceCandidate(new RTCIceCandidate({
        candidate: candidate,
        sdpMLineIndex: sdpMLineIndex
      }));
      console.log('Added ICE candidate from server');
    } catch (error) {
      console.error('Failed to add ICE candidate:', error);
    }
  }, []);

  const cleanupWebRTC = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    webrtcInitialized.current = false;
    setWebrtcStream(null);
  }, []);

  const handleMessage = useCallback((message) => {
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
        if (message.webrtc && !webrtcInitialized.current) {
          initWebRTC();
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
        if (message.webrtc) {
          initWebRTC();
        }
        break;

      case 'stream-switched':
        // Hot-swap: pipeline restarts, need new WebRTC negotiation
        console.log('Stream switched to:', message.source);
        setStatus({
          streaming: true,
          source: message.source,
          mode: message.mode
        });
        break;

      case 'webrtc-reconnect':
        // Server requests WebRTC reconnection (after hot-swap)
        console.log('WebRTC reconnection requested');
        cleanupWebRTC();
        // Small delay to let cleanup finish, then wait for new offer
        break;

      case 'webrtc-offer':
        // Server (GStreamer) sent us an SDP offer
        handleOffer(message.sdp);
        break;

      case 'webrtc-ice-candidate':
        // Server (GStreamer) sent us an ICE candidate
        handleIceCandidate(message.candidate, message.sdpMLineIndex);
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
  }, [initWebRTC, handleOffer, handleIceCandidate, cleanupWebRTC]);

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
