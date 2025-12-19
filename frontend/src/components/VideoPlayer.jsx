import { useEffect, useRef } from 'react';

export function VideoPlayer({ src, webrtcStream }) {
  const videoRef = useRef(null);

  // Handle HLS source
  useEffect(() => {
    if (videoRef.current && src && !webrtcStream) {
      videoRef.current.src = src;
      videoRef.current.load();
      videoRef.current.play().catch(() => {});
    }
  }, [src, webrtcStream]);

  // Handle WebRTC stream
  useEffect(() => {
    if (videoRef.current && webrtcStream) {
      console.log('Setting WebRTC stream on video element');
      videoRef.current.srcObject = webrtcStream;
      videoRef.current.play().catch((err) => {
        console.error('Video play error:', err);
      });
    }
    return () => {
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [webrtcStream]);

  const hasVideo = src || webrtcStream;

  return (
    <div className="video-container">
      {hasVideo ? (
        <video
          ref={videoRef}
          controls
          autoPlay
          muted
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#000' }}
        />
      ) : (
        <div className="video-placeholder">
          <span>No video stream</span>
        </div>
      )}
    </div>
  );
}
