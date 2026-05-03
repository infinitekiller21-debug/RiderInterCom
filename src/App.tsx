/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { Mic, MicOff, Users, Radio, Wifi, WifiOff, Settings, Info, ChevronRight, Activity } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Constants & Types ---
const RIDE_ID_KEY = 'rider_cast_group_id';

interface PeerConnection {
  socketId: string;
  pc: RTCPeerConnection;
  stream?: MediaStream;
}

export default function App() {
  // --- State ---
  const [groupId, setGroupId] = useState<string>(() => localStorage.getItem(RIDE_ID_KEY) || '');
  const [isJoined, setIsJoined] = useState(false);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [peers, setPeers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [audioLevel, setAudioLevel] = useState(0);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    const handleBeforeInstallPrompt = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  // --- Refs ---
  const socketRef = useRef<Socket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, PeerConnection>>(new Map());
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // --- Audio Logic ---
  const setupLocalMedia = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      localStreamRef.useCurrent = stream;
      
      // setup visualizer
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      
      audioContextRef.current = ctx;
      analyserRef.current = analyser;
      
      const updateLevel = () => {
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((p, c) => p + c, 0) / dataArray.length;
        setAudioLevel(average);
        if (isMicOn) requestAnimationFrame(updateLevel);
      };
      updateLevel();

      return stream;
    } catch (err) {
      console.error('Mic access denied:', err);
      setError('Microphone access is required for intercom.');
      return null;
    }
  };

  const createPeerConnection = useCallback((targetSocketId: string, isOffer: boolean) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit('signal', {
          to: targetSocketId,
          signal: { candidate: event.candidate }
        });
      }
    };

    pc.ontrack = (event) => {
      console.log('Received remote track from:', targetSocketId);
      const remoteStream = event.streams[0];
      const audio = new Audio();
      audio.srcObject = remoteStream;
      audio.play().catch(console.error);
      
      peersRef.current.get(targetSocketId)!.stream = remoteStream;
    };

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }

    if (isOffer) {
      pc.createOffer().then(offer => {
        return pc.setLocalDescription(offer);
      }).then(() => {
        socketRef.current?.emit('signal', {
          to: targetSocketId,
          signal: { sdp: pc.localDescription }
        });
      });
    }

    return pc;
  }, []);

  // --- Socket Logic ---
  const joinRide = async () => {
    if (!groupId) return;
    localStorage.setItem(RIDE_ID_KEY, groupId);
    
    const stream = await setupLocalMedia();
    if (!stream) return;

    const socket = io('/', {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 2000,
      timeout: 10000,
    });
    
    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      socket.emit('join-ride', groupId);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('ride-roster', (otherRiders: string[]) => {
      setPeers(otherRiders);
      otherRiders.forEach(id => {
        const pc = createPeerConnection(id, true);
        peersRef.current.set(id, { socketId: id, pc });
      });
    });

    socket.on('rider-joined', (newRiderId) => {
      setPeers(prev => [...new Set([...prev, newRiderId])]);
      const pc = createPeerConnection(newRiderId, false);
      peersRef.current.set(newRiderId, { socketId: newRiderId, pc });
    });

    socket.on('signal', async ({ from, signal }) => {
      const peer = peersRef.current.get(from);
      if (!peer) return;

      if (signal.sdp) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        if (signal.sdp.type === 'offer') {
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          socket.emit('signal', { to: from, signal: { sdp: peer.pc.localDescription } });
        }
      } else if (signal.candidate) {
        await peer.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    });

    socket.on('rider-left', (id) => {
      setPeers(prev => prev.filter(pId => pId !== id));
      const peer = peersRef.current.get(id);
      if (peer) {
        peer.pc.close();
        peersRef.current.delete(id);
      }
    });

    setIsJoined(true);
  };

  const toggleMic = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = !isMicOn;
      });
      setIsMicOn(!isMicOn);
    }
  };

  const leaveRide = () => {
    socketRef.current?.disconnect();
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    peersRef.current.forEach(p => p.pc.close());
    peersRef.current.clear();
    setPeers([]);
    setIsJoined(false);
    setIsConnected(false);
  };

  const installApp = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setDeferredPrompt(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#E6E6E6] flex items-center justify-center p-4 font-mono">
      {/* Rugged Widget Shell */}
      <div className="w-full max-w-md bg-[#151619] rounded-[24px] shadow-2xl border-4 border-[#2A2B30] overflow-hidden flex flex-col aspect-[9/16] relative">
        
        {/* Top Bezels / Status Bar */}
        <div className="p-6 pb-2 flex justify-between items-center text-[#8E9299] text-[10px] tracking-widest uppercase">
          <div className="flex items-center gap-2">
            <Radio size={12} className={isConnected ? "text-orange-500 animate-pulse" : ""} />
            <span>RiderCast v1.0</span>
          </div>
          <div className="flex items-center gap-3">
            {!isOnline && (
              <span className="flex items-center gap-1 bg-red-500/20 px-2 py-0.5 rounded text-red-500 font-bold border border-red-500/30">
                OFFLINE CACHED
              </span>
            )}
            {isConnected ? (
              <span className="flex items-center gap-1"><Wifi size={12} className="text-green-500" /> SYNC</span>
            ) : (
              <span className="flex items-center gap-1"><WifiOff size={12} className="text-red-500" /> NO LINK</span>
            )}
            <Activity size={12} />
          </div>
        </div>

        <main className="flex-1 p-6 flex flex-col gap-6">
          {!isJoined ? (
            <div className="flex flex-col gap-8 h-full justify-center">
              <div className="text-center">
                <h1 className="text-white text-3xl font-bold tracking-tighter mb-2">INTERCOM</h1>
                <p className="text-[#8E9299] text-xs uppercase tracking-widest">Local Mesh Connection</p>
              </div>

              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-[#8E9299] text-[10px] uppercase font-bold px-2">Group ID</label>
                  <input
                    type="text"
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value.toUpperCase())}
                    placeholder="ENTER RIDE CODE..."
                    className="w-full bg-[#1A1B1E] border-2 border-[#2A2B30] p-4 text-white placeholder-[#3A3B40] rounded-xl focus:outline-none focus:border-orange-500 transition-colors uppercase"
                  />
                </div>
                
                <button
                  onClick={joinRide}
                  disabled={!groupId}
                  className="w-full bg-orange-500 hover:bg-orange-600 disabled:bg-[#2A2B30] disabled:text-[#4A4B50] text-[#151619] font-black py-5 rounded-xl transition-all active:scale-[0.98] flex items-center justify-center gap-3 group"
                >
                  INITIALIZE LINK <ChevronRight size={20} className="group-hover:translate-x-1 transition-transform" />
                </button>
              </div>

              <div className="mt-auto bg-[#1A1B1E] p-4 rounded-xl border border-[#2A2B30]">
                <div className="flex items-center gap-3 text-[#8E9299]">
                   <Info size={16} />
                   <p className="text-[10px] leading-tight font-sans">
                     Connect all phones to the same mobile hotspot. One rider acts as the hub. Max 10 connections.
                   </p>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col h-full gap-6">
              {/* Visualizer Area */}
              <div className="flex-1 bg-[#1A1B1E] rounded-2xl border-2 border-[#2A2B30] relative overflow-hidden flex flex-col items-center justify-center">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,#2a2b30_0%,transparent_70%)] opacity-30" />
                
                {/* Audio Rings */}
                <div 
                  className="w-48 h-48 rounded-full border-2 border-dashed border-[#2A2B30] flex items-center justify-center relative"
                  style={{ transform: `scale(${1 + (audioLevel / 255) * 0.5})` }}
                >
                   <div 
                    className="w-36 h-36 rounded-full border-2 border-[#3A3B40] flex items-center justify-center transition-colors duration-75"
                    style={{ borderColor: isMicOn ? (audioLevel > 50 ? '#f97316' : '#3A3B40') : '#ef4444' }}
                   >
                     <motion.div 
                        animate={{ scale: isMicOn && audioLevel > 20 ? [1, 1.1, 1] : 1 }}
                        transition={{ repeat: Infinity, duration: 0.15 }}
                        className={`w-24 h-24 rounded-full flex items-center justify-center shadow-2xl ${isMicOn ? 'bg-orange-500 shadow-orange-500/20' : 'bg-red-500 shadow-red-500/20'}`}
                     >
                       {isMicOn ? <Mic size={40} className="text-[#151619]" /> : <MicOff size={40} className="text-[#151619]" />}
                     </motion.div>
                   </div>
                </div>

                <div className="mt-8 text-center z-10 px-6">
                   <h2 className="text-white text-lg font-bold tracking-tight">GROUP: {groupId}</h2>
                   <div className="flex items-center justify-center gap-2 mt-1">
                     <span className={`w-2 h-2 rounded-full ${isMicOn ? (isOnline ? 'bg-green-500' : 'bg-orange-500') : 'bg-red-500'} animate-pulse`} />
                     <span className="text-[#8E9299] text-[10px] uppercase font-bold">
                       {!isOnline ? 'LAN ONLY MODE' : (isMicOn ? (audioLevel > 10 ? 'BROADCASTING...' : 'OPEN CHANNEL') : 'MUTED')}
                     </span>
                   </div>
                </div>
              </div>

              {/* Roster & Controls */}
              <div className="space-y-4">
                <div className="flex items-center justify-between px-2 text-[#8E9299] text-[10px] uppercase font-bold">
                  <div className="flex items-center gap-2">
                    <Users size={14} />
                    <span>Active Riders ({peers.length + 1})</span>
                  </div>
                  <span>LINK STRENGTH: 98%</span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={toggleMic}
                    className={`p-4 rounded-xl border-2 flex flex-col items-center gap-2 transition-all group ${isMicOn ? 'bg-[#1A1B1E] border-[#2A2B30] text-white hover:border-[#3A3B40]' : 'bg-red-500/10 border-red-500 text-red-500'}`}
                  >
                    {isMicOn ? <MicOff size={24} /> : <Mic size={24} />}
                    <span className="text-[10px] uppercase font-bold">{isMicOn ? 'MUTE' : 'UNMUTE'}</span>
                  </button>
                  
                  <button
                    onClick={leaveRide}
                    className="p-4 rounded-xl border-2 border-[#2A2B30] bg-[#1A1B1E] text-white hover:border-red-500 hover:text-red-500 transition-all group flex flex-col items-center gap-2"
                  >
                    <Radio size={24} />
                    <span className="text-[10px] uppercase font-bold">DISCONNECT</span>
                  </button>
                </div>

                {/* Peer List (Horizontal Scroll) */}
                <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-none">
                  {peers.map((id) => (
                    <div key={id} className="flex-shrink-0 bg-[#1A1B1E] border border-[#2A2B30] px-4 py-2 rounded-lg flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-green-500" />
                      <span className="text-[#8E9299] text-[10px] lowercase">peer_{id.slice(0,4)}</span>
                    </div>
                  ))}
                  {peers.length === 0 && (
                    <div className="w-full text-center py-2 text-[#4A4B50] text-[10px] uppercase border border-dashed border-[#2A2B30] rounded-lg">
                      WAITING FOR OTHERS...
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </main>

        {/* Bottom Bezel */}
        <div className="p-4 bg-[#1A1B1E] border-t-2 border-[#2A2B30] flex justify-around">
           {deferredPrompt && (
             <button onClick={installApp} className="text-orange-500 hover:text-orange-400 transition-colors flex items-center gap-2">
               <ChevronRight size={16} className="rotate-90" />
               <span className="text-[10px] font-bold">INSTALL</span>
             </button>
           )}
           <button className="text-[#4A4B50] hover:text-white transition-colors"><Settings size={20} /></button>
           <button className="text-[#4A4B50] hover:text-white transition-colors"><Info size={20} /></button>
        </div>

        {/* Global Error Popover */}
        <AnimatePresence>
          {error && (
            <motion.div 
              initial={{ y: 50, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 50, opacity: 0 }}
              className="absolute bottom-20 left-6 right-6 bg-red-600 text-white p-4 rounded-xl shadow-xl flex items-center justify-between"
            >
              <span className="text-xs font-bold uppercase">{error}</span>
              <button onClick={() => setError(null)} className="text-white/80">×</button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Decorative Surroundings */}
      <div className="fixed top-12 left-12 text-[#151619]/10 font-black text-9xl pointer-events-none select-none uppercase">RIDER</div>
      <div className="fixed bottom-12 right-12 text-[#151619]/10 font-black text-9xl pointer-events-none select-none uppercase">CAST</div>
    </div>
  );
}
