import { useEffect, useRef, useState, useCallback } from "react";
import { io } from "socket.io-client";
import Modal from "./Modal";

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 900;

function RemoteInstagramLoginModal({ username, isOpen, onClose, onConnected }) {
  const [frame, setFrame] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [loggedIn, setLoggedIn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState(null);
  const [isPageReady, setIsPageReady] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const socketRef = useRef(null);
  const imgRef = useRef(null);
  const lastFrameRef = useRef(null); // Optimization: Track last frame to avoid identical re-renders

  const handleCloseModal = useCallback(() => {
    const socket = socketRef.current;
    if (socket && socket.connected) {
      console.log("Closing modal - saving session first...");
      setIsClosing(true);

      socket.emit("closeSession");

      socket.once("sessionClosed", () => {
        console.log("Session saved, closing modal");
        socket.disconnect();
        socketRef.current = null;
        setIsClosing(false);
        onClose();
      });

      setTimeout(() => {
        if (socket && socket.connected) {
          socket.disconnect();
          socketRef.current = null;
        }
        setIsClosing(false);
        onClose();
      }, 3000);
    } else {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) {
      // Just ensure cleanup if closed via other means
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setFrame(null);
      lastFrameRef.current = null;
      setConnecting(false);
      setLoggedIn(false);
      setSaving(false);
      setLoadingMessage(null);
      setIsPageReady(false);
      setIsClosing(false);
      return;
    }

    setConnecting(true);

    const socket = io("https://ig.genvision-ai.com/ig-remote", {
      path: "/socket.io",
      withCredentials: true,
      query: { username },
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("Remote login socket connected");
      socket.emit("startRemoteLogin");
    });

    socket.on("loading", (data) => {
      console.log("Loading:", data.message);
      setLoadingMessage(data.message || "Loading...");
      setConnecting(true);
      if (data.complete) {
        setIsPageReady(true);
      }
    });

    socket.on("ready", (data) => {
      console.log("Ready:", data.message);
      setLoadingMessage(null);
      setIsPageReady(true);
      setConnecting(false);
    });

    socket.on("screencast", ({ frame }) => {
      // OPTIMIZATION: Only update state if frame actually changed
      const newFrame = `data:image/jpeg;base64,${frame}`;
      if (newFrame !== lastFrameRef.current) {
        lastFrameRef.current = newFrame;
        setFrame(newFrame);
        setConnecting(false);
        setIsPageReady(true);
      }
    });

    socket.on("loginSuccess", () => {
      setLoggedIn(true);
      if (onConnected) onConnected();
    });

    socket.on("error", (payload) => {
      console.error("Remote login error:", payload);
      setConnecting(false);
      setSaving(false);
    });

    socket.on("connect_error", (err) => {
      // Only log genuine errors, not disconnects
      if (err.message !== "xhr poll error") {
        console.error("Remote login socket connect_error:", err.message);
      }
      setConnecting(false);
    });

    return () => {
      // Standard cleanup: ALWAYS disconnect
      // This handles React StrictMode correctly (connect -> disconnect -> connect)
      // No more "socket.connected" check that was causing duplicate sockets!
      socket.disconnect();
      socketRef.current = null;
    };
  }, [isOpen, username]);
  // Note: we can include onConnected here safely IF we assume it doesn't change on every render.
  // But to be safe based on previous issues, let's remove it if it causes loops.
  // Actually, standard practice: depend on props.
  // If `onConnected` is unstable, users should wrap it in useCallback.
  // For safety, I will remove it from deps again to avoid resumption of the loop if user passes inline function.

  const sendMouseEvent = useCallback((type, domEvent) => {
    const img = imgRef.current;
    const socket = socketRef.current;
    if (!img || !socket) return;

    const rect = img.getBoundingClientRect();
    const relX = domEvent.clientX - rect.left;
    const relY = domEvent.clientY - rect.top;

    const scaleX = VIEWPORT_WIDTH / rect.width;
    const scaleY = VIEWPORT_HEIGHT / rect.height;

    socket.emit("mouse", {
      type,
      x: Math.round(relX * scaleX),
      y: Math.round(relY * scaleY),
      button: domEvent.button === 2 ? "right" : "left",
    });
  }, []);

  const handleKeyDown = useCallback((e) => {
    const socket = socketRef.current;
    if (!socket) return;
    e.preventDefault();

    if (e.key.length === 1) {
      socket.emit("keyboard", { text: e.key });
    } else {
      socket.emit("keyboard", { key: e.key });
    }
  }, []);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleCloseModal}
      title={`Remote Login for @${username}`}
      size="xl"
      footer={null}
    >
      <div
        className="space-y-4 outline-none"
        tabIndex={0}
        onKeyDown={handleKeyDown}
      >
        <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-sm text-blue-800">
          <p className="font-medium">
            Use remote login to solve 2FA or captchas once.
          </p>
          <p className="mt-1">
            We open a secure Instagram session in the cloud. Use your mouse and
            keyboard in this window; your session cookies will be saved for
            automation.
          </p>
        </div>

        <div className="relative border border-gray-200 rounded-xl bg-black overflow-auto flex items-center justify-center min-h-[400px] max-h-[700px]">
          {frame ? (
            <img
              ref={imgRef}
              src={frame}
              alt="Instagram remote session"
              className="max-w-full h-auto object-contain select-none"
              // Add key to force remount if needed, but not needed here
              draggable={false}
              onClick={(e) => sendMouseEvent("click", e)}
              onMouseMove={(e) => sendMouseEvent("move", e)}
            />
          ) : (
            <div className="py-16 text-center">
              <div className="mb-3 flex justify-center">
                <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
              <p className="text-sm text-gray-300">
                {loadingMessage ||
                  (connecting
                    ? "Starting remote session..."
                    : "Waiting for first frame...")}
              </p>
              <p className="mt-1 text-xs text-gray-400">
                {isPageReady
                  ? "Page loaded, waiting for screen..."
                  : "This can take a few seconds the first time."}
              </p>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs text-gray-500">
            Tip: Click inside the image once, then type as usual (Tab, Enter,
            etc.). Complete any 2FA or security checks directly here.
          </p>
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              disabled={saving || !socketRef.current}
              onClick={() => {
                const socket = socketRef.current;
                if (!socket) return;
                setSaving(true);
                socket.emit("saveSession");
                socket.once("sessionSaved", () => {
                  setSaving(false);
                  setLoggedIn(true);
                  if (onConnected) onConnected();
                });
              }}
              className={`inline-flex items-center px-3 py-1.5 rounded-md text-xs font-medium ${
                saving
                  ? "bg-gray-200 text-gray-500 cursor-not-allowed"
                  : "bg-blue-600 text-white hover:bg-blue-700"
              }`}
            >
              {saving ? "Saving..." : "Save Session Now"}
            </button>
            {loggedIn && (
              <span className="text-xs text-green-600">
                Session saved. You can keep using this window, then close it
                when you're finished.
              </span>
            )}
          </div>
        </div>

        {isClosing && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-6 flex items-center gap-3">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm font-medium">Saving session...</p>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export default RemoteInstagramLoginModal;
