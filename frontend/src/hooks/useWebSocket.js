import { useState, useEffect, useCallback, useRef } from 'react';

const WS_URL = `ws://${window.location.host}/ws`;

// Deep merge KLV data, keeping last known values for missing fields
function mergeKLV(prev, next) {
  if (!prev) return next;
  if (!next) return prev;

  const result = { ...prev };
  for (const key of Object.keys(next)) {
    if (next[key] !== null && next[key] !== undefined) {
      if (typeof next[key] === 'object' && !Array.isArray(next[key])) {
        result[key] = mergeKLV(prev[key], next[key]);
      } else {
        result[key] = next[key];
      }
    }
  }
  return result;
}

// ICE servers (STUN + local TURN for NAT traversal)
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Local coturn TURN server on same host
  { urls: `turn:${window.location.hostname}:3478`, username: 'klv', credential: 'klv123' }
];

export function useWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [klvData, setKlvData] = useState(null);           // Combined/primary sensor data
  const [sensors, setSensors] = useState({});              // All sensors by ID
  const [status, setStatus] = useState({ streaming: false, source: null, mode: null });
  const [hlsUrl, setHlsUrl] = useState(null);
  const [webrtcStream, setWebrtcStream] = useState(null);
  const [clientId, setClientId] = useState(null);

  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const pcRef = useRef(null);  // RTCPeerConnection
  const webrtcInitialized = useRef(false);
  const sensorTimestamps = useRef({});    // Last KLV timestamp PER SENSOR
  const sensorMissions = useRef({});      // Last Mission ID PER SENSOR
  const lastMissionId = useRef(null);     // Last mission ID for stream change detection
  const lastResetTime = useRef(0);        // Grace period after reset
  const sensorLastSeen = useRef({});      // Track last seen time per sensor

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
          setHlsUrl(message.hlsUrl);
        } else {
          setHlsUrl(null);
        }
        // Initialize WebRTC if UDP stream is active
        if (message.webrtc && !webrtcInitialized.current) {
          initWebRTC();
        }
        break;

      case 'klv':
        {
          const sensorId = message.sensorId || 'default';
          const sensorName = message.sensorName || sensorId;
          const data = { ...message.data, _sensorName: sensorName };
          const currentTs = data.unixTimestamp;
          const currentMission = data.mission?.id;
          // Per-sensor timestamp and mission tracking (sensors can have very different values!)
          const lastTs = sensorTimestamps.current[sensorId] || null;
          const lastMission = sensorMissions.current[sensorId] || null;
          const now = Date.now();

          // Grace period: don't detect new stream for 2s after a reset
          const inGracePeriod = (now - lastResetTime.current) < 2000;

          // Detect stream change via:
          // 1. Mission ID changed
          // 2. Timestamp goes backward or jumps > 5 seconds
          let isNewStream = false;

          if (!inGracePeriod) {
            if (lastMission !== null && currentMission && currentMission !== lastMission) {
              console.log(`Auto-lock: Mission ID changed (${lastMission} -> ${currentMission})`);
              isNewStream = true;
            } else if (lastTs !== null && currentTs !== null) {
              const delta = currentTs - lastTs;
              if (delta < -1 || delta > 5) {
                console.log(`Auto-lock: Timestamp discontinuity (delta=${delta}s)`);
                isNewStream = true;
              }
            }
          }

          // Update last seen time for this sensor
          sensorLastSeen.current[sensorId] = now;

          if (isNewStream) {
            console.log(`Auto-lock: Resetting sensors, starting with "${sensorId}"`);
            setSensors({ [sensorId]: data });
            setKlvData(data);
            lastResetTime.current = now;
            sensorLastSeen.current = { [sensorId]: now };
            // Reset per-sensor timestamps for new stream
            sensorTimestamps.current = { [sensorId]: currentTs };
          } else {
            // Remove stale sensors (not seen for 3 seconds)
            const SENSOR_TIMEOUT = 3000;
            const staleSensors = Object.keys(sensorLastSeen.current)
              .filter(id => now - sensorLastSeen.current[id] > SENSOR_TIMEOUT);

            if (staleSensors.length > 0) {
              console.log(`Auto-lock: Removing stale sensors: ${staleSensors.join(', ')}`);
              staleSensors.forEach(id => delete sensorLastSeen.current[id]);
            }

            setSensors(prev => {
              // Remove stale sensors from state
              const updated = { ...prev };
              staleSensors.forEach(id => delete updated[id]);
              // Log new sensor detection
              if (!prev[sensorId]) {
                console.log(`[KLV] New sensor detected: "${sensorId}"`);
              }
              // Add/update current sensor
              updated[sensorId] = mergeKLV(prev[sensorId], data);
              return updated;
            });
            setKlvData(prev => mergeKLV(prev, data));
          }

          // Update per-sensor timestamp and mission tracking
          if (currentTs !== null) sensorTimestamps.current[sensorId] = currentTs;
          if (currentMission) sensorMissions.current[sensorId] = currentMission;
        }
        break;

      case 'stream-started':
        setStatus({
          streaming: true,
          source: message.source,
          mode: message.mode
        });
        if (message.hlsUrl) {
          setHlsUrl(message.hlsUrl);
        }
        // Initialize WebRTC if available
        if (message.webrtc) {
          initWebRTC();
        }
        // Reset tracking for new stream
        sensorTimestamps.current = {};
        lastMissionId.current = null;
        break;

      case 'source-switching':
        // Just log - auto-lock will handle sensor reset via KLV gap detection
        console.log('Source switching...');
        break;

      case 'stream-switched':
        // Hot-swap: just update status - auto-lock handles sensors
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
        setSensors({});
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
    sensors,        // All sensors by ID (for multi-sensor display)
    status,
    hlsUrl,
    webrtcStream,
    clientId,
    startStream,
    startUDP,
    stopStream
  };
}
