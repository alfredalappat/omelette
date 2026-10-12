(() => {
  const socket = io();
  const $ = (s) => document.querySelector(s);

  const ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      // For production, add a TURN server so users behind strict NATs can connect:
      // { urls: 'turn:your.turn.server:3478', username: 'user', credential: 'pass' },
    ],
  };

  const el = {
    landing: $('#landing'), chat: $('#chat'), chatBody: $('#chatBody'),
    status: $('#status'), onlineLanding: $('#onlineLanding'), onlineChat: $('#onlineChat'),
    remoteVideo: $('#remoteVideo'), localVideo: $('#localVideo'),
    placeholder: $('#remotePlaceholder'), placeholderText: $('#placeholderText'),
    messages: $('#messages'), typing: $('#typing'), composer: $('#composer'),
    input: $('#msgInput'), sendBtn: $('#sendBtn'),
    ageCheck: $('#ageCheck'), ageWarn: $('#ageWarn'),
    nextBtn: $('#nextBtn'), stopBtn: $('#stopBtn'), muteBtn: $('#muteBtn'), camBtn: $('#camBtn'),
    reportBtn: $('#reportBtn'), toast: $('#toast'),
  };

  let mode = null;            // 'video' | 'text'
  let pc = null;              // RTCPeerConnection
  let localStream = null;
  let pendingCandidates = [];
  let inChat = false;         // currently paired with a stranger
  let typingTimer = null;
  let sentTyping = false;

  // ---------- helpers ----------
  function toast(text) {
    el.toast.textContent = text;
    el.toast.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (el.toast.hidden = true), 2600);
  }

  function setStatus(text, live = false) {
    el.status.textContent = text;
    el.status.classList.toggle('live', live);
  }

  function addMessage(text, kind) {
    const div = document.createElement('div');
    div.className = `msg ${kind}`;
    div.textContent = text; // textContent prevents XSS
    el.messages.appendChild(div);
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function setPlaceholder(visible, text = '', spinning = true) {
    el.placeholder.hidden = !visible;
    el.placeholderText.textContent = text;
    el.placeholder.querySelector('.spinner').style.display = spinning ? 'block' : 'none';
  }

  function setChatEnabled(on) {
    el.input.disabled = !on;
    el.sendBtn.disabled = !on;
    if (on) el.input.focus();
  }

  // ---------- WebRTC ----------
  function closePeer() {
    if (pc) {
      pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null;
      pc.close();
      pc = null;
    }
    pendingCandidates = [];
    el.remoteVideo.srcObject = null;
  }

  async function createPeer(initiator) {
    closePeer();
    pc = new RTCPeerConnection(ICE_CONFIG);

    if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    pc.ontrack = (e) => {
      el.remoteVideo.srcObject = e.streams[0];
      setPlaceholder(false);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('signal', { candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (pc && pc.connectionState === 'failed') toast('Connection problem. Try Next.');
    };

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { description: pc.localDescription });
    }
  }

  async function handleSignal({ description, candidate }) {
    if (!pc) return;
    try {
      if (description) {
        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', { description: pc.localDescription });
        }
        for (const c of pendingCandidates) await pc.addIceCandidate(c);
        pendingCandidates = [];
      } else if (candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(candidate);
        else pendingCandidates.push(candidate);
      }
    } catch (err) {
      console.error('Signal error', err);
    }
  }

  // ---------- flow ----------
  async function start(selectedMode) {
    if (!el.ageCheck.checked) {
      el.ageWarn.hidden = false;
      return;
    }
    el.ageWarn.hidden = true;
    mode = selectedMode;

    el.chatBody.classList.toggle('text-only', mode === 'text');
    el.muteBtn.hidden = el.camBtn.hidden = mode === 'text';

    if (mode === 'video') {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        el.localVideo.srcObject = localStream;
      } catch (err) {
        toast('Camera/microphone access is needed for video chat.');
        return;
      }
    }

    el.landing.hidden = true;
    el.chat.hidden = false;
    search();
  }

  function search() {
    closePeer();
    inChat = false;
    el.messages.innerHTML = '';
    el.typing.hidden = true;
    setChatEnabled(false);
    setStatus('Looking for someone…');
    setPlaceholder(true, 'Looking for someone…');
    addMessage('Looking for a stranger to chat with…', 'sys');
    socket.emit('find', { mode });
  }

  function leaveChat() {
    socket.emit('stop');
    closePeer();
    inChat = false;
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
      el.localVideo.srcObject = null;
    }
    el.chat.hidden = true;
    el.landing.hidden = false;
    mode = null;
  }

  // ---------- socket events ----------
  socket.on('online', (n) => {
    el.onlineLanding.textContent = n;
    el.onlineChat.textContent = n;
  });

  socket.on('waiting', () => setStatus('Waiting for a stranger…'));

  socket.on('matched', async ({ initiator }) => {
    inChat = true;
    el.messages.innerHTML = '';
    addMessage("You're now chatting with a random stranger. Say hi! 👋", 'sys');
    setStatus('Connected', true);
    setChatEnabled(true);
    if (mode === 'video') {
      setPlaceholder(true, 'Connecting video…');
      await createPeer(initiator);
    } else {
      setPlaceholder(false);
    }
  });

  socket.on('signal', handleSignal);

  socket.on('message', (text) => {
    addMessage(text, 'them');
    el.typing.hidden = true;
  });

  socket.on('typing', (isTyping) => (el.typing.hidden = !isTyping));

  socket.on('partner-left', () => {
    closePeer();
    inChat = false;
    setChatEnabled(false);
    el.typing.hidden = true;
    setStatus('Stranger disconnected');
    setPlaceholder(true, 'Stranger left the chat', false);
    addMessage('Stranger has disconnected. Hit Next to meet someone new.', 'sys');
  });

  socket.on('connect', () => {
    // If the socket reconnects mid-chat, start over cleanly
    if (!el.chat.hidden) search();
  });

  // ---------- UI events ----------
  $('#startVideo').addEventListener('click', () => start('video'));
  $('#startText').addEventListener('click', () => start('text'));
  el.nextBtn.addEventListener('click', search);
  el.stopBtn.addEventListener('click', leaveChat);

  $('#rulesLink').addEventListener('click', (e) => {
    e.preventDefault();
    toast('Be respectful. No nudity, harassment, hate or illegal content. Never share personal info.');
  });

  el.muteBtn.addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    el.muteBtn.classList.toggle('off', !track.enabled);
    el.muteBtn.textContent = track.enabled ? '🎤' : '🔇';
  });

  el.camBtn.addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    el.camBtn.classList.toggle('off', !track.enabled);
    el.camBtn.textContent = track.enabled ? '📷' : '🚫';
  });

  el.reportBtn.addEventListener('click', () => {
    if (!inChat) return toast('Nobody to report right now.');
    socket.emit('report');
    toast('Reported. Thanks for keeping Omelette safe. Finding someone new…');
    search();
  });

  el.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.input.value.trim();
    if (!text || !inChat) return;
    socket.emit('message', text);
    addMessage(text, 'me');
    el.input.value = '';
    stopTyping();
  });

  function stopTyping() {
    clearTimeout(typingTimer);
    if (sentTyping) {
      sentTyping = false;
      socket.emit('typing', false);
    }
  }

  el.input.addEventListener('input', () => {
    if (!inChat) return;
    if (!sentTyping) {
      sentTyping = true;
      socket.emit('typing', true);
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 1500);
  });

  // Keyboard shortcut: Esc = Next
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.chat.hidden) search();
  });

  window.addEventListener('beforeunload', () => socket.emit('stop'));
})();
