/**
 * AI Voice Chat Widget
 * An embeddable voice chat widget with AI integration
 */

(function () {
  'use strict';

  // Widget configuration
  const CONFIG = {
    apiKey: null,
    apiEndpoint: null,
    theme: 'light',
    welcomeMessage: 'Hello! How can I help you today?',
    debug: true,
    // === BYPASS CONFIGURATION ===
    // Set to true to disable API key validation (for development/testing)
    bypassApiKeyValidation: true  // Currently forced to true for public access
  };

  // Utility functions
  const log = (...args) => {
    if (CONFIG.debug) {
      console.log('[AI Widget]', ...args);
    }
  };

  const error = (...args) => {
    console.error('[AI Widget]', ...args);
  };

  // Widget class
  class AIVoiceWidget {
    constructor(config) {
      this.config = { ...CONFIG, ...config };
      this.sessionId = this.generateSessionId();
      this.history = [];
      this.isRecording = false;
      this.isLoading = false;
      this.persistentCallMode = false;
      this.isInCall = false;
      this.shouldKeepListening = false;
      this.suspendedForTTS = false;
      this.ignoreRecognitionForTTS = false;
      this.recognition = null;
      this.synthesis = null;
      // Hold an open microphone stream so the browser only asks permission once
      this.micStream = null;
      this.shadowRoot = null;
      this.activeTab = 'chat';

      this.init();
    }

    // Pre-warm microphone permission so that subsequent SpeechRecognition
    // restarts don’t trigger a new permission prompt.
    async prewarmMic() {
      try {
        if (!this.micStream) {
          this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          log('Microphone stream acquired and cached');
        }
      } catch (e) {
        error('Unable to access microphone:', e);
        throw e; // Re-throw to prevent speech recognition setup
      }
    }

    // Clean up resources when widget is destroyed
    cleanup() {
      if (this.micStream) {
        this.micStream.getTracks().forEach(track => track.stop());
        this.micStream = null;
        log('Microphone stream stopped');
      }

      if (this.recognition) {
        this.recognition.stop();
        this.recognition = null;
      }

      if (this.synthesis) {
        this.synthesis.cancel();
      }

      this.shouldKeepListening = false;
      this.isRecording = false;
      this.isInCall = false;
      this.suspendedForTTS = false;
      this.ignoreRecognitionForTTS = false;
    }

    generateSessionId() {
      return 'session_' + Math.random().toString(36).substr(2, 9);
    }

    async init() {
      log('Starting widget initialization...');

      this.createShadowDOM();
      log('Shadow DOM created');

      // Obtain mic permission up-front and setup speech recognition
      try {
        await this.prewarmMic();
        this.setupSpeechRecognition();
        log('Speech recognition setup complete');
      } catch (e) {
        error('Failed to initialize microphone:', e);
        // Continue without voice features
      }

      this.setupSpeechSynthesis();
      log('Speech synthesis setup complete');
      this.bindEvents();
      log('Events bound');
      this.addWelcomeMessage();
      log('Widget fully initialized and should be visible');
    }

    createShadowDOM() {
      // Create widget container
      const container = document.createElement('div');
      container.id = 'ai-voice-widget';

      // Create shadow DOM
      this.shadowRoot = container.attachShadow({ mode: 'closed' });

      // Add styles
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            position: fixed;
            bottom: 30px;
            right: 30px;
            z-index: 10000;
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            --primary-gradient: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
            --glass-bg: rgba(255, 255, 255, 0.65);
            --glass-border: rgba(255, 255, 255, 0.5);
            --glass-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.15);
            --blur: blur(16px);
            --text-color: #1f2937;
            --chat-bg: #ffffff;
            --user-msg-bg: linear-gradient(135deg, #6366f1, #8b5cf6);
            --ai-msg-bg: #f3f4f6;
          }

          /* Dark Mode Variables */
          :host(.dark) {
            --glass-bg: rgba(30, 41, 59, 0.8);
            --glass-border: rgba(255, 255, 255, 0.1);
            --text-color: #f8fafc;
            --chat-bg: #0f172a;
            --ai-msg-bg: #334155;
          }
          
          .widget-container {
            background: var(--glass-bg);
            backdrop-filter: var(--blur);
            -webkit-backdrop-filter: var(--blur);
            border: 1px solid var(--glass-border);
            border-radius: 24px;
            box-shadow: var(--glass-shadow);
            width: 380px;
            height: 500px;
            max-height: 80vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            transform-origin: bottom right;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            opacity: 0;
            transform: scale(0.9) translateY(20px);
            pointer-events: none;
            position: absolute;
            bottom: 0;
            right: 0;
          }
          
          .widget-container.open {
            opacity: 1;
            transform: scale(1) translateY(0);
            pointer-events: all;
          }

          /* Navigation Tabs */
          .nav-tabs {
            display: flex;
            padding: 16px 16px 0;
            gap: 12px;
            border-bottom: 1px solid rgba(0,0,0,0.05);
            position: relative;
            z-index: 10;
          }

          .nav-tab {
            flex: 1;
            background: transparent;
            border: none;
            padding: 12px;
            font-size: 15px;
            font-weight: 600;
            color: var(--text-color);
            opacity: 0.6;
            cursor: pointer;
            position: relative;
            transition: all 0.3s ease;
          }

          .nav-tab.active {
            opacity: 1;
          }

          .nav-tab.active::after {
            content: '';
            position: absolute;
            bottom: -1px;
            left: 0;
            width: 100%;
            height: 3px;
            background: var(--primary-gradient);
            border-radius: 3px 3px 0 0;
          }
          
          .close-btn {
            position: absolute;
            top: 16px;
            right: 16px;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0,0,0,0.05);
            border: none;
            border-radius: 50%;
            cursor: pointer;
            font-size: 18px;
            color: var(--text-color);
            transition: background 0.2s;
            z-index: 20;
          }
          
          .close-btn:hover {
            background: rgba(0,0,0,0.1);
          }

          /* Content Area */
          .tab-content {
            flex: 1;
            position: relative;
            overflow: hidden;
          }

          .view {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s;
            opacity: 0;
            pointer-events: none;
            transform: translateX(30px);
          }

          .view.active {
            opacity: 1;
            pointer-events: all;
            transform: translateX(0);
          }

          /* Chat View Styles */
          .chat-history {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 16px;
            scroll-behavior: smooth;
          }

          .message {
            max-width: 85%;
            padding: 12px 18px;
            border-radius: 18px;
            font-size: 14px;
            line-height: 1.5;
            position: relative;
            animation: messageSlide 0.3s ease-out backwards;
            box-shadow: 0 2px 5px rgba(0,0,0,0.05);
          }

          .message.user {
            background: var(--user-msg-bg);
            color: white;
            align-self: flex-end;
            border-bottom-right-radius: 4px;
            box-shadow: 0 4px 15px rgba(99, 102, 241, 0.25);
          }

          .message.assistant {
            background: var(--ai-msg-bg);
            color: var(--text-color);
            align-self: flex-start;
            border-bottom-left-radius: 4px;
          }

          .input-area {
            padding: 16px;
            background: rgba(255,255,255,0.3);
            display: flex;
            gap: 10px;
            align-items: center;
          }

          .message-input {
            flex: 1;
            padding: 12px 20px;
            border: 1px solid rgba(0,0,0,0.08);
            border-radius: 25px;
            background: rgba(255,255,255,0.8);
            font-size: 14px;
            color: var(--text-color);
            transition: all 0.3s;
          }

          .message-input:focus {
            outline: none;
            border-color: #a855f7;
            background: white;
            box-shadow: 0 0 0 4px rgba(168, 85, 247, 0.1);
          }

          .icon-btn {
            width: 44px;
            height: 44px;
            border: none;
            border-radius: 50%;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            transition: all 0.2s;
            background: var(--primary-gradient);
            color: white;
            box-shadow: 0 4px 12px rgba(168, 85, 247, 0.3);
          }

          .icon-btn:hover {
            transform: scale(1.05);
            box-shadow: 0 6px 16px rgba(168, 85, 247, 0.4);
          }

          /* Call View Styles - Premium Redesign */
          .call-view-content {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            background: linear-gradient(-45deg, #1e1b4b, #312e81, #4c1d95, #5b21b6);
            background-size: 400% 400%;
            animation: gradientBG 15s ease infinite;
            position: relative;
            z-index: 1;
          }
          
          @keyframes gradientBG {
            0% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
            100% { background-position: 0% 50%; }
          }
          
          /* Ambient glowing orbs in background */
          .call-view-content::before {
            content: '';
            position: absolute;
            top: -20%;
            left: -20%;
            width: 140%;
            height: 140%;
            background: radial-gradient(circle at 50% 50%, rgba(99, 102, 241, 0.15), transparent 60%);
            z-index: 0;
            pointer-events: none;
          }

          .status-text {
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 2px;
            font-weight: 600;
            color: rgba(255, 255, 255, 0.9);
            margin-top: 40px;
            text-shadow: 0 2px 10px rgba(0,0,0,0.3);
            z-index: 2;
          }

          .visualizer-container {
            position: relative;
            width: 200px;
            height: 200px;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 30px 0;
            z-index: 2;
          }

          /* Complex layered orb effect */
          .visualizer-circle {
            position: absolute;
            border-radius: 50%;
            background: transparent;
            border: 2px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 0 30px rgba(99, 102, 241, 0.1);
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
          }
          
          .visualizer-circle.animate {
             animation: pulse-ring 2s cubic-bezier(0.25, 0.46, 0.45, 0.94) infinite;
          }

          .visualizer-circle:nth-child(1) { width: 100%; height: 100%; animation-delay: 0s; border-color: rgba(167, 139, 250, 0.3); }
          .visualizer-circle:nth-child(2) { width: 75%; height: 75%; animation-delay: 0.3s; border-color: rgba(139, 92, 246, 0.4); }
          .visualizer-circle:nth-child(3) { width: 50%; height: 50%; animation-delay: 0.6s; border-color: rgba(124, 58, 237, 0.5); }

          .main-mic-btn {
            width: 90px;
            height: 90px;
            border-radius: 50%;
            background: linear-gradient(135deg, #8b5cf6, #6366f1);
            box-shadow: 
              0 0 0 8px rgba(255, 255, 255, 0.05),
              0 0 0 16px rgba(255, 255, 255, 0.02),
              0 15px 35px rgba(0,0,0,0.3);
            border: none;
            z-index: 5;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 36px;
            color: white;
            cursor: pointer;
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            position: relative;
            overflow: hidden;
          }
          
          /* Shine effect on button */
          .main-mic-btn::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent);
            transition: 0.5s;
          }
          
          .main-mic-btn:hover::before {
            left: 100%;
          }

          .main-mic-btn:hover {
            transform: scale(1.05);
            box-shadow: 
              0 0 0 10px rgba(255, 255, 255, 0.1),
              0 0 0 20px rgba(255, 255, 255, 0.03),
              0 20px 40px rgba(0,0,0,0.4);
          }

          .main-mic-btn.active {
            transform: scale(1.1);
            background: linear-gradient(135deg, #ef4444, #f87171);
            box-shadow: 0 0 50px rgba(239, 68, 68, 0.6);
            animation: breathe 3s ease-in-out infinite;
          }
          
          @keyframes breathe {
            0%, 100% { transform: scale(1.1); box-shadow: 0 0 30px rgba(239, 68, 68, 0.5); }
            50% { transform: scale(1.15); box-shadow: 0 0 60px rgba(239, 68, 68, 0.8); }
          }
          
          .call-controls {
            display: flex;
            gap: 30px;
            margin-top: auto;
            margin-bottom: 60px;
            z-index: 2;
          }

          .control-btn {
            width: 50px;
            height: 50px;
            border-radius: 50%;
            border: 1px solid rgba(255,255,255,0.1);
            background: rgba(255,255,255,0.1);
            backdrop-filter: blur(10px);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            cursor: pointer;
            transition: all 0.3s;
            color: rgba(255,255,255,0.8);
          }

          .control-btn.end-call {
            background: rgba(239, 68, 68, 0.2);
            border-color: rgba(239, 68, 68, 0.4);
            color: #fca5a5;
            width: 60px;
            height: 60px;
            font-size: 24px;
          }

          .control-btn:hover {
            background: rgba(255,255,255,0.2);
            transform: translateY(-5px);
            color: white;
          }
          
          .control-btn.end-call:hover {
            background: rgba(239, 68, 68, 0.8);
            color: white;
            box-shadow: 0 10px 30px rgba(239, 68, 68, 0.4);
          }

          /* Floating Action Button (FAB) */
          .fab {
            background: var(--primary-gradient);
            width: 64px;
            height: 64px;
            border-radius: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 30px;
            border: none;
            cursor: pointer;
            box-shadow: 0 8px 24px rgba(99, 102, 241, 0.4);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            position: fixed;
            bottom: 30px;
            right: 30px;
            z-index: 10001;
          }

          .fab:hover {
            transform: scale(1.1) rotate(5deg);
            box-shadow: 0 12px 32px rgba(99, 102, 241, 0.5);
          }
          
          .fab.hidden {
            transform: scale(0) rotate(-180deg);
            opacity: 0;
            pointer-events: none;
          }

          @keyframes messageSlide {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
          }

          @keyframes pulse-ring {
            0% { transform: scale(0.8); opacity: 0.5; }
            100% { transform: scale(2.5); opacity: 0; }
          }
          
          @keyframes ping {
            75%, 100% { transform: scale(1.5); opacity: 0; }
          }
        </style>
        
        <div class="widget-container" id="widgetContainer">
          <button class="close-btn" id="closeBtn">×</button>
          
          <div class="nav-tabs">
            <button class="nav-tab active" data-tab="chat">AI Chat</button>
            <button class="nav-tab" data-tab="call">AI Call</button>
          </div>

          <div class="tab-content">
            <!-- Chat View -->
            <div class="view active" id="chatView">
              <div class="chat-history" id="chatContainer">
                <!-- Messages go here -->
              </div>
              <div class="input-area">
                <input type="text" class="message-input" id="messageInput" placeholder="Type a message..." />
                <button class="icon-btn" id="sendBtn">➤</button>
              </div>
            </div>

            <!-- Call View -->
            <div class="view" id="callView">
              <div class="call-view-content">
                <div class="visualizer-container">
                  <div class="visualizer-circle"></div>
                  <div class="visualizer-circle"></div>
                  <div class="visualizer-circle"></div>
                  <button class="main-mic-btn" id="voiceBtn">🎤</button>
                </div>
                <div class="status-text" id="statusText">Tap to start call</div>
                
                <div class="call-controls">
                  <!-- <button class="control-btn" title="Mute">🔇</button> -->
                  <button class="control-btn end-call" id="endCallBtn" title="End Call">📞</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        
        <button class="fab" id="fabBtn">💬</button>
      `;

      // Add to DOM
      document.body.appendChild(container);

      // Get references
      this.elements = {
        container: this.shadowRoot.getElementById('widgetContainer'),
        fab: this.shadowRoot.getElementById('fabBtn'),
        closeBtn: this.shadowRoot.getElementById('closeBtn'),
        // Tabs
        tabs: this.shadowRoot.querySelectorAll('.nav-tab'),
        views: this.shadowRoot.querySelectorAll('.view'),
        // Chat Elements
        chatContainer: this.shadowRoot.getElementById('chatContainer'),
        messageInput: this.shadowRoot.getElementById('messageInput'),
        sendBtn: this.shadowRoot.getElementById('sendBtn'),
        // Call Elements
        voiceBtn: this.shadowRoot.getElementById('voiceBtn'), // Main Mic Button
        endCallBtn: this.shadowRoot.getElementById('endCallBtn'),
        statusText: this.shadowRoot.getElementById('statusText'),
        visualizers: this.shadowRoot.querySelectorAll('.visualizer-circle')
      };

      this.activeTab = 'chat';
    }

    switchTab(tabId) {
      if (this.activeTab === tabId) return;
      this.activeTab = tabId;

      // Update UI
      this.elements.tabs.forEach(tab => {
        if (tab.dataset.tab === tabId) tab.classList.add('active');
        else tab.classList.remove('active');
      });

      this.elements.views.forEach(view => {
        if (view.id === `${tabId}View`) view.classList.add('active');
        else view.classList.remove('active');
      });
    }

    togglePersistentCallMode() {
      // Feature deprecated or needs redesign for new UI
      // For now, simple console log as it wasn't core to visual overhaul
      log('Persistent mode toggled (internal flag only)');
      this.persistentCallMode = !this.persistentCallMode;
    }

    setupSpeechRecognition() {
      if ('webkitSpeechRecognition' in window) {
        this.recognition = new webkitSpeechRecognition();
        // Use continuous mode to avoid repeated permission prompts
        this.recognition.continuous = true;
        this.recognition.interimResults = false;
        this.recognition.lang = 'en-US';

        this.recognition.onresult = (event) => {
          // Ignore results if TTS is playing or we're suspended
          if (this.ignoreRecognitionForTTS || this.suspendedForTTS) {
            log('Ignoring recognition result due to TTS playback');
            return;
          }

          const transcript = event.results[event.results.length - 1][0].transcript;
          log('Recognition result:', transcript);

          // If in call mode, we don't necessarily need to populate the chat input
          // But we should still process the message
          this.sendMessage(transcript);
        };

        // Handle recognition ending - restart only if intentionally stopped
        this.recognition.onend = () => {
          this.isRecording = false;
          // Update visual state if in call
          if (this.elements.voiceBtn) this.elements.voiceBtn.classList.remove('active');
          this.elements.visualizers.forEach(v => v.classList.remove('animate'));

          // Skip auto-restart if we intentionally paused for TTS
          if (this.suspendedForTTS) return;

          // Only restart if we're still in a call and recognition ended unexpectedly
          if (this.isInCall && this.shouldKeepListening) {
            this.restartRecognition();
          } else if (this.isInCall) {
            // If in call but stopped listening (maybe error?), show status
            this.elements.statusText.textContent = "Tap to speak";
          }
        };

        this.recognition.onerror = (event) => {
          error('Speech recognition error:', event.error);
          this.isRecording = false;
          if (this.elements.voiceBtn) this.elements.voiceBtn.classList.remove('active');
          this.elements.visualizers.forEach(v => v.classList.remove('animate'));

          // Don't restart on permission errors to avoid loops
          if (event.error === 'not-allowed') {
            error('Microphone permission denied');
            this.shouldKeepListening = false;
            this.elements.statusText.textContent = "Microphone denied";
          }
        };
      } else {
        log('Speech recognition not supported');
      }
    }

    // Controlled restart function to avoid permission issues
    restartRecognition() {
      if (!this.recognition || !this.shouldKeepListening) {
        log('Cannot restart recognition - missing recognition or shouldKeepListening is false');
        return;
      }

      try {
        // Use a short delay to avoid Chrome's throttling
        setTimeout(() => {
          if (this.isInCall && this.shouldKeepListening && !this.suspendedForTTS) {
            log('Restarting speech recognition...');
            this.recognition.start();
            this.isRecording = true;
            if (this.elements.voiceBtn) this.elements.voiceBtn.classList.add('active');
            this.elements.visualizers.forEach(v => v.classList.add('animate'));
            this.elements.statusText.textContent = "Listening...";
            log('Speech recognition restarted successfully');
          }
        }, 100);
      } catch (e) {
        error('Failed to restart recognition:', e);
        this.shouldKeepListening = false;
      }
    }

    setupSpeechSynthesis() {
      if ('speechSynthesis' in window) {
        this.synthesis = window.speechSynthesis;
      } else {
        log('Speech synthesis not supported');
      }
    }

    bindEvents() {
      // FAB button
      this.elements.fab.addEventListener('click', () => {
        this.openWidget();
      });

      // Close button
      this.elements.closeBtn.addEventListener('click', () => {
        this.closeWidget();
      });

      // Tab Switching
      this.elements.tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          this.switchTab(tab.dataset.tab);
        });
      });

      // Call Button (Mic in Call View)
      this.elements.voiceBtn.addEventListener('click', () => {
        if (!this.isInCall) {
          this.startCall();
        } else {
          // Toggle recording/listening logic if already in call layout
          this.toggleRecording();
        }
      });

      // End call button
      this.elements.endCallBtn.addEventListener('click', () => {
        this.endCall();
      });

      // Send Button
      this.elements.sendBtn.addEventListener('click', () => {
        const message = this.elements.messageInput.value.trim();
        if (message) {
          this.sendMessage(message);
          this.elements.messageInput.value = '';
        }
      });

      // Handle text input on Enter key
      this.elements.messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          const message = this.elements.messageInput.value.trim();
          if (message) {
            this.sendMessage(message);
            this.elements.messageInput.value = '';
          }
        }
      });
    }

    openWidget() {
      this.elements.container.classList.add('open');
      this.elements.fab.classList.add('hidden');
      this.elements.fab.style.display = 'none';
      if (this.activeTab === 'chat') {
        this.elements.messageInput.focus();
      }
    }

    closeWidget() {
      this.elements.container.classList.remove('open');
      this.elements.fab.classList.remove('hidden');
      this.elements.fab.style.display = 'flex';
    }

    startCall() {
      // Force switch to call tab
      this.switchTab('call');

      this.isInCall = true;
      this.shouldKeepListening = true;
      this.elements.statusText.textContent = "Connecting...";
      this.toggleRecording();
    }

    endCall() {
      this.shouldKeepListening = false;
      this.isInCall = false;
      this.isRecording = false;

      if (this.recognition) {
        this.recognition.stop();
      }

      // Update UI
      this.elements.voiceBtn.classList.remove('active');
      this.elements.visualizers.forEach(v => v.classList.remove('animate'));
      this.elements.statusText.textContent = "Call Ended";

      // Maybe switch back to chat after a second?
      setTimeout(() => {
        if (this.elements.statusText.textContent === "Call Ended") {
          this.elements.statusText.textContent = "Tap to start call";
        }
      }, 1500);

      log('Call ended');
    }

    toggleRecording() {
      if (!this.recognition) {
        alert('Speech recognition not supported in this browser');
        return;
      }

      if (this.isRecording) {
        // Stop recording
        this.shouldKeepListening = false; // Pause listening
        this.recognition.stop();
        // Note: onend will handle UI removal
      } else {
        // Start recording
        this.shouldKeepListening = true;
        try {
          this.recognition.start();
          this.isRecording = true;
          this.elements.voiceBtn.classList.add('active');
          this.elements.visualizers.forEach(v => v.classList.add('animate'));
          this.elements.statusText.textContent = "Listening...";
        } catch (e) {
          error('Failed to start recognition:', e);
          this.shouldKeepListening = false;
          this.elements.statusText.textContent = "Error starting mic";
        }
      }
    }

    addMessage(content, role = 'user') {
      const messageDiv = document.createElement('div');
      messageDiv.className = `message ${role}`;
      messageDiv.textContent = content;

      this.elements.chatContainer.appendChild(messageDiv);
      this.elements.chatContainer.scrollTop = this.elements.chatContainer.scrollHeight;
    }

    addWelcomeMessage() {
      this.addMessage(this.config.welcomeMessage, 'assistant');
    }

    showLoading() {
      const loadingDiv = document.createElement('div');
      loadingDiv.className = 'loading';
      loadingDiv.innerHTML = `
        <span>AI is typing</span>
        <div class="loading-dots">
          <div class="loading-dot"></div>
          <div class="loading-dot"></div>
          <div class="loading-dot"></div>
        </div>
      `;
      loadingDiv.id = 'loading';

      this.elements.chatContainer.appendChild(loadingDiv);
      this.elements.chatContainer.scrollTop = this.elements.chatContainer.scrollHeight;
    }

    hideLoading() {
      const loading = this.elements.chatContainer.querySelector('#loading');
      if (loading) {
        loading.remove();
      }
    }

    async sendMessage(message) {
      if (this.isLoading) return;

      this.isLoading = true;
      // Disable inputs if desired, but in chat we let them type

      // Add user message
      this.addMessage(message, 'user');
      this.history.push({ role: 'user', content: message });

      // Show loading
      this.showLoading();

      try {
        const headers = {
          'Content-Type': 'application/json'
        };

        if (!CONFIG.bypassApiKeyValidation && this.config.apiKey) {
          headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }

        const response = await fetch(this.config.apiEndpoint, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({
            message,
            sessionId: this.sessionId,
            history: this.history
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || `API error: ${response.status}`);
        }

        const data = await response.json();

        this.hideLoading();
        this.addMessage(data.response, 'assistant');
        this.history.push({ role: 'assistant', content: data.response });

        // Speak response
        this.speak(data.response);

      } catch (err) {
        error('Error sending message:', err);
        this.hideLoading();
        this.addMessage('Sorry, I encountered an error. Please try again.', 'assistant');
      } finally {
        this.isLoading = false;
      }
    }

    speak(text) {
      if (!this.synthesis) return;

      this.synthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.9;
      utterance.pitch = 1;
      utterance.volume = 1;

      const wasRecording = this.isRecording;
      // If we are recording, stop it so we don't hear ourselves
      if (this.isRecording) {
        this.recognition.stop();
        this.isRecording = false;
        // Update UI to show "Speaking..." or something?
        if (this.isInCall) {
          this.elements.statusText.textContent = "AI Speaking...";
          this.elements.visualizers.forEach(v => v.classList.remove('animate')); // Stop pulse while AI speaks
          this.elements.voiceBtn.classList.remove('active');
        }
        this.suspendedForTTS = true;
      }

      utterance.onend = () => {
        this.suspendedForTTS = false;
        this.ignoreRecognitionForTTS = false;

        // Restart recognition if we're in a call
        if (this.isInCall && this.shouldKeepListening) {
          this.restartRecognition();
        } else if (this.isInCall) {
          this.elements.statusText.textContent = "Tap to speak";
        }
      };

      utterance.onerror = () => {
        this.suspendedForTTS = false;
        this.ignoreRecognitionForTTS = false;
        if (this.isInCall && this.shouldKeepListening) {
          this.restartRecognition();
        }
      };

      this.synthesis.speak(utterance);
    }
  }

  // Widget initialization
  function initWidget() {
    console.log('[AI Widget] initWidget called');

    // Find the script tag that loaded this widget
    const scripts = document.getElementsByTagName('script');
    let widgetScript = null;

    // Look for our script by checking src attribute
    for (let script of scripts) {
      if (script.src && script.src.includes('ai-voice-widget.js')) {
        widgetScript = script;
        break;
      }
    }

    if (!widgetScript) {
      console.error('[AI Widget] Widget script tag not found');
      return;
    }

    const config = {
      apiKey: widgetScript.dataset.apiKey,
      apiEndpoint: widgetScript.dataset.apiEndpoint,
      theme: widgetScript.dataset.theme || 'light',
      welcomeMessage: widgetScript.dataset.welcomeMessage || 'Hello! How can I help you today?',
      debug: true // Force debug mode
    };

    // === BYPASS CONFIGURATION ===
    const BYPASS_API_KEY_VALIDATION = CONFIG.bypassApiKeyValidation;

    if (!BYPASS_API_KEY_VALIDATION) {
      if (!config.apiKey) {
        error('API key is required');
        return;
      }
    }

    if (!config.apiEndpoint) {
      console.warn('[AI Widget] No API endpoint provided, using default deployed backend');
      config.apiEndpoint = 'https://ai-voice-widget.onrender.com/chat';
    }

    console.log('[AI Widget] Creating widget instance...');
    new AIVoiceWidget(config);
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidget);
  } else {
    initWidget();
  }

})();
