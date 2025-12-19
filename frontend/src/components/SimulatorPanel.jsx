import { useState, useEffect } from 'react';

const API_URL = 'http://localhost:3001';

export function SimulatorPanel() {
  const [files, setFiles] = useState([]);
  const [currentFile, setCurrentFile] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/simulator/files`)
      .then(res => res.json())
      .then(data => setFiles(data.files))
      .catch(err => console.error('Failed to load files:', err));
  }, []);

  const startSimulator = async (fileId) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/simulator/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, port: 5000 })
      });
      const data = await res.json();
      if (data.success) {
        setCurrentFile(fileId);
      }
    } catch (err) {
      console.error('Failed to start simulator:', err);
    }
    setLoading(false);
  };

  const stopSimulator = async () => {
    try {
      await fetch(`${API_URL}/api/simulator/stop`, { method: 'POST' });
      setCurrentFile(null);
    } catch (err) {
      console.error('Failed to stop simulator:', err);
    }
  };

  return (
    <div className="simulator-panel">
      <div className="simulator-header">
        <span>Simulator</span>
        {currentFile && (
          <button onClick={stopSimulator} className="stop-btn">Stop</button>
        )}
      </div>
      <div className="simulator-files">
        {files.map(file => (
          <button
            key={file.id}
            onClick={() => startSimulator(file.id)}
            disabled={loading}
            className={currentFile === file.id ? 'active' : ''}
          >
            {file.name}
          </button>
        ))}
      </div>
    </div>
  );
}
