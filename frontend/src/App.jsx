import { useState } from 'react';
import { VideoPlayer } from './components/VideoPlayer';
import { Map } from './components/Map';
import { InfoPanel } from './components/InfoPanel';
import { SimulatorPanel } from './components/SimulatorPanel';
import { useWebSocket } from './hooks/useWebSocket';
import './App.css';

function App() {
  const { isConnected, klvData, status, hlsUrl, webrtcStream, startStream, startUDP, stopStream } = useWebSocket();
  const [filePath, setFilePath] = useState('');
  const [udpPort, setUdpPort] = useState('5000');

  return (
    <div className="app">
      <header className="app-header">
        <h1>STANAG 4609 Viewer</h1>
        <div className="controls">
          {!status.streaming ? (
            <>
              <input
                type="text"
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder="Path to .ts or .mpg file"
                className="file-input"
              />
              <button onClick={() => startStream(filePath)} disabled={!isConnected}>
                File
              </button>
              <span className="separator">|</span>
              <input
                type="number"
                value={udpPort}
                onChange={(e) => setUdpPort(e.target.value)}
                className="port-input"
                placeholder="5000"
              />
              <button onClick={() => startUDP(parseInt(udpPort))} disabled={!isConnected} className="live">
                Live UDP
              </button>
            </>
          ) : (
            <>
              <span className="source-info">
                {status.mode === 'udp'
                  ? `WebRTC :${status.source?.split(':').pop()}`
                  : 'File (HLS)'}
              </span>
              {webrtcStream && <span className="rtc-badge">RTC</span>}
              <button onClick={stopStream} className="stop">
                Stop
              </button>
            </>
          )}
        </div>
      </header>

      <main className="app-main">
        <div className="left-panel">
          <VideoPlayer src={hlsUrl} webrtcStream={webrtcStream} />
          <Map klvData={klvData} />
        </div>
        <div className="right-panel">
          <InfoPanel
            klvData={klvData}
            status={status}
            isConnected={isConnected}
          />
          <SimulatorPanel />
        </div>
      </main>
    </div>
  );
}

export default App;
