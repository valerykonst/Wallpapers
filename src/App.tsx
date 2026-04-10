/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect } from 'react';
import { GoogleGenAI } from "@google/genai";
import { motion, AnimatePresence } from "motion/react";
import { 
  Sparkles, 
  Download, 
  RefreshCw, 
  X, 
  Maximize2, 
  Settings2, 
  ChevronDown,
  Loader2,
  Image as ImageIcon,
  Smartphone,
  LogOut,
  User as UserIcon,
  Crown,
  AlertCircle
} from "lucide-react";
import confetti from 'canvas-confetti';
import { cn } from './lib/utils';
import { auth, db, signInWithGoogle, logout } from './lib/firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc, onSnapshot, increment, serverTimestamp } from 'firebase/firestore';
import { loadStripe } from '@stripe/stripe-js';

// Types
type AspectRatio = "1:1" | "2:3" | "3:2" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9";
type ImageSize = "1K" | "2K" | "4K";

interface GeneratedImage {
  id: string;
  url: string;
  prompt: string;
  timestamp: number;
}

interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  generationCount: number;
  isPro: boolean;
}

export default function App() {
  // State
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [selectedImage, setSelectedImage] = useState<GeneratedImage | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("9:16");
  const [imageSize, setImageSize] = useState<ImageSize>("1K");
  const [error, setError] = useState<string | null>(null);
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [isSlow, setIsSlow] = useState(false);
  
  // Auth & Profile State
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

  // Check for API key and Auth on mount
  useEffect(() => {
    const checkKey = async () => {
      try {
        const selected = await (window as any).aistudio.hasSelectedApiKey();
        setHasApiKey(selected);
      } catch (e) {
        setHasApiKey(false);
      }
    };
    checkKey();

    // Check for Stripe redirect params
    const params = new URLSearchParams(window.location.search);
    if (params.get('success')) {
      confetti({
        particleCount: 150,
        spread: 100,
        origin: { y: 0.6 },
        colors: ['#FBBF24', '#F59E0B', '#D97706'] // Gold colors for Pro
      });
      // Clear params without refresh
      window.history.replaceState({}, '', window.location.pathname);
    }

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setIsAuthLoading(false);
      
      if (currentUser) {
        // Listen to profile changes
        const userRef = doc(db, 'users', currentUser.uid);
        const unsubProfile = onSnapshot(userRef, (docSnap) => {
          if (docSnap.exists()) {
            setProfile(docSnap.data() as UserProfile);
          } else {
            // Create profile if it doesn't exist
            const newProfile = {
              uid: currentUser.uid,
              email: currentUser.email || '',
              displayName: currentUser.displayName || '',
              generationCount: 0,
              isPro: false,
              createdAt: serverTimestamp()
            };
            setDoc(userRef, newProfile);
            setProfile(newProfile as any);
          }
        });
        return () => unsubProfile();
      } else {
        setProfile(null);
      }
    });

    return () => unsubscribe();
  }, []);

  const handleUpgrade = async () => {
    if (!user) return;
    try {
      const response = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.uid, userEmail: user.email })
      });
      const { url } = await response.json();
      if (url) window.location.href = url;
    } catch (err) {
      console.error("Upgrade error:", err);
      setError("Failed to start checkout. Please try again.");
    }
  };

  const handleConnectKey = async () => {
    try {
      await (window as any).aistudio.openSelectKey();
      // Assume success as per skill instructions
      setHasApiKey(true);
    } catch (e) {
      console.error("Failed to open key selector:", e);
    }
  };

  const generateImages = async (isRemix = false) => {
    if (!prompt.trim()) return;

    if (!user) {
      setError("Please sign in to generate wallpapers.");
      return;
    }

    if (profile && profile.generationCount >= 1 && !profile.isPro) {
      setShowUpgradeModal(true);
      return;
    }
    
    // Create a new instance right before the call to get the latest key
    const apiKey = process.env.API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      setError("API Key not found. Please connect your Gemini API key.");
      return;
    }
    const ai = new GoogleGenAI({ apiKey });

    setIsGenerating(true);
    setError(null);
    setIsSlow(false);
    setImages([]); // Clear previous images to show skeletons
    
    const slowTimer = setTimeout(() => setIsSlow(true), 30000);

    try {
      // We generate 4 variations. 
      // Note: gemini-3.1-flash-image-preview generates one image per call.
      const generateSingleImage = async (retryCount = 0): Promise<GeneratedImage | null> => {
        try {
          const contents: any = {
            parts: [
              { text: prompt + (isRemix ? " (inspired by the reference image)" : "") }
            ]
          };

          if (isRemix && referenceImage) {
            contents.parts.unshift({
              inlineData: {
                data: referenceImage.split(',')[1],
                mimeType: "image/png"
              }
            });
          }

          // Increased timeout to 300 seconds
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("Request timed out after 300 seconds")), 300000)
          );

          const apiPromise = ai.models.generateContent({
            model: 'gemini-3.1-flash-image-preview',
            contents,
            config: {
              imageConfig: {
                aspectRatio,
                imageSize
              }
            }
          });

          const response: any = await Promise.race([apiPromise, timeoutPromise]);

          if (!response?.candidates?.[0]?.content?.parts) {
            throw new Error("The model returned an empty response.");
          }

          for (const part of response.candidates[0].content.parts) {
            if (part.inlineData) {
              const newImg = {
                id: Math.random().toString(36).substring(7),
                url: `data:image/png;base64,${part.inlineData.data}`,
                prompt,
                timestamp: Date.now()
              };
              // Update state incrementally
              setImages(prev => [...prev, newImg]);
              return newImg;
            }
          }
          throw new Error("No image data found.");
        } catch (err: any) {
          if (retryCount < 1 && !err.message.includes("timed out")) {
            console.log(`Retrying image generation... (Attempt ${retryCount + 2})`);
            return generateSingleImage(retryCount + 1);
          }
          throw err;
        }
      };

      // Run in two sequential batches of 2 to avoid overwhelming the connection/rate limits
      await Promise.allSettled([generateSingleImage(), generateSingleImage()]);
      await Promise.allSettled([generateSingleImage(), generateSingleImage()]);
      
      // Increment generation count
      if (user) {
        const userRef = doc(db, 'users', user.uid);
        await updateDoc(userRef, {
          generationCount: increment(1)
        });
      }
      
    } catch (err: any) {
      console.error("Generation error:", err);
      let message = err.message || "An unexpected error occurred.";
      if (message.includes("429")) message = "Rate limit exceeded. Please wait a moment before trying again.";
      if (message.includes("403")) {
        message = "Permission denied. This model requires a paid Gemini API key. Please ensure you've selected a valid key in the setup.";
        setHasApiKey(false);
      }
      setError(message);
    } finally {
      clearTimeout(slowTimer);
      setIsGenerating(false);
      setIsSlow(false);
      // Success confetti if we have images
      setImages(currentImages => {
        if (currentImages.length > 0) {
          confetti({
            particleCount: 100,
            spread: 70,
            origin: { y: 0.6 },
            colors: ['#8B5CF6', '#EC4899', '#3B82F6']
          });
        }
        return currentImages;
      });
    }
  };

  const handleDownload = (imageUrl: string, id: string) => {
    const link = document.createElement('a');
    link.href = imageUrl;
    link.download = `vibewall-${id}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleRemix = (image: GeneratedImage) => {
    setReferenceImage(image.url);
    setPrompt(image.prompt);
    setSelectedImage(null);
    generateImages(true);
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white font-sans selection:bg-purple-500/30 overflow-x-hidden">
      {/* Background Atmosphere */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-purple-900/20 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-900/20 blur-[120px] rounded-full" />
      </div>

      <AnimatePresence>
        {hasApiKey === false && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-xl flex items-center justify-center p-6"
          >
            <div className="max-w-sm w-full bg-white/5 border border-white/10 rounded-3xl p-8 text-center shadow-2xl">
              <div className="w-16 h-16 bg-purple-500/20 rounded-2xl flex items-center justify-center mx-auto mb-6">
                <Sparkles className="w-8 h-8 text-purple-400" />
              </div>
              <h2 className="text-2xl font-bold mb-3">Connect Gemini API</h2>
              <p className="text-white/60 text-sm mb-8 leading-relaxed">
                High-quality image generation requires a paid Gemini API key. 
                Please select a key from a paid Google Cloud project to continue.
              </p>
              <div className="space-y-4">
                <button
                  onClick={handleConnectKey}
                  className="w-full bg-white text-black font-bold py-4 rounded-2xl hover:bg-white/90 transition-all shadow-[0_0_20px_rgba(255,255,255,0.2)]"
                >
                  Select API Key
                </button>
                <a 
                  href="https://ai.google.dev/gemini-api/docs/billing" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="block text-xs text-white/40 hover:text-white/60 transition-colors"
                >
                  Learn more about billing
                </a>
              </div>
            </div>
          </motion.div>
        )}

        {showUpgradeModal && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-xl flex items-center justify-center p-6"
          >
            <div className="max-w-sm w-full bg-white/5 border border-white/10 rounded-3xl p-8 text-center shadow-2xl">
              <div className="w-16 h-16 bg-yellow-500/20 rounded-2xl flex items-center justify-center mx-auto mb-6">
                <Crown className="w-8 h-8 text-yellow-400" />
              </div>
              <h2 className="text-2xl font-bold mb-3">Upgrade to Pro</h2>
              <p className="text-white/60 text-sm mb-8 leading-relaxed">
                You've used your free generation. Upgrade to VibeWall Pro for unlimited high-quality wallpapers.
              </p>
              <div className="space-y-4">
                <button
                  onClick={handleUpgrade}
                  className="w-full bg-yellow-500 text-black font-bold py-4 rounded-2xl hover:bg-yellow-400 transition-all shadow-[0_0_20px_rgba(234,179,8,0.3)]"
                >
                  Get Unlimited Access
                </button>
                <button
                  onClick={() => setShowUpgradeModal(false)}
                  className="w-full bg-white/5 text-white/60 font-medium py-3 rounded-xl hover:bg-white/10 transition-all"
                >
                  Maybe Later
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="relative z-10 max-w-lg mx-auto px-6 pt-12 pb-32">
        {/* Header */}
        <header className="mb-12 text-center relative">
          <div className="absolute top-0 right-0">
            {isAuthLoading ? (
              <Loader2 className="w-5 h-5 animate-spin text-white/20" />
            ) : user ? (
              <div className="flex items-center gap-3">
                <div className="flex flex-col items-end">
                  <span className="text-[10px] font-bold text-white/40 uppercase tracking-widest">{profile?.isPro ? 'Pro Member' : 'Free Plan'}</span>
                  <span className="text-[10px] text-white/20">{profile?.generationCount || 0} generations</span>
                </div>
                <button 
                  onClick={() => logout()}
                  className="p-2 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
                  title="Sign Out"
                >
                  <LogOut className="w-4 h-4 text-white/40" />
                </button>
              </div>
            ) : (
              <button 
                onClick={() => signInWithGoogle()}
                className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
              >
                <UserIcon className="w-4 h-4 text-white/40" />
                <span className="text-xs font-bold text-white/60">Sign In</span>
              </button>
            )}
          </div>
          <motion.div 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 mb-4"
          >
            <Smartphone className="w-4 h-4 text-purple-400" />
            <span className="text-[10px] uppercase tracking-[0.2em] font-semibold text-white/60">Wallpaper Engine</span>
          </motion.div>
          <motion.h1 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="text-5xl font-bold tracking-tighter mb-2 bg-gradient-to-b from-white to-white/50 bg-clip-text text-transparent"
          >
            VibeWall
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
            className="text-white/40 text-sm font-medium"
          >
            Describe your vibe, generate your aesthetic.
          </motion.p>
        </header>

        {/* Input Section */}
        <section className="mb-8">
          <AnimatePresence>
            {referenceImage && (
              <motion.div 
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mb-4 relative inline-block"
              >
                <div className="text-[10px] uppercase tracking-widest font-bold text-white/40 mb-2 ml-1">Remixing Reference</div>
                <div className="relative w-20 aspect-[9/16] rounded-lg overflow-hidden border border-purple-500/50">
                  <img src={referenceImage} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                  <button 
                    onClick={() => setReferenceImage(null)}
                    className="absolute top-1 right-1 p-0.5 bg-black/60 rounded-full hover:bg-black/80 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="relative group">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. rainy cyberpunk lo-fi street at night with neon reflections..."
              className="w-full bg-white/5 border border-white/10 rounded-2xl p-5 pr-12 text-lg focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-all min-h-[120px] resize-none placeholder:text-white/20"
            />
            <div className="absolute top-4 right-4 text-white/20 group-focus-within:text-purple-400 transition-colors">
              <Sparkles className="w-5 h-5" />
            </div>
          </div>

          <div className="mt-4 flex items-center justify-between gap-4">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-all",
                showSettings 
                  ? "bg-white/10 border-white/20 text-white" 
                  : "bg-transparent border-white/10 text-white/60 hover:border-white/20"
              )}
            >
              <Settings2 className="w-4 h-4" />
              <span className="text-sm font-medium">Settings</span>
              <ChevronDown className={cn("w-3 h-3 transition-transform", showSettings && "rotate-180")} />
            </button>

            <button
              onClick={() => generateImages()}
              disabled={isGenerating || !prompt.trim()}
              className="flex-1 bg-white text-black font-bold py-2.5 rounded-xl hover:bg-white/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex flex-col items-center justify-center gap-1 shadow-[0_0_20px_rgba(255,255,255,0.2)]"
            >
              {isGenerating ? (
                <>
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Generating...</span>
                  </div>
                  {isSlow && (
                    <span className="text-[10px] text-black/60 animate-pulse">Taking longer than usual...</span>
                  )}
                </>
              ) : (
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4" />
                  <span>Generate</span>
                </div>
              )}
            </button>
          </div>

          {/* Settings Drawer */}
          <AnimatePresence>
            {showSettings && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div className="pt-4 grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-[10px] uppercase tracking-widest font-bold text-white/40 ml-1">Aspect Ratio</label>
                    <select 
                      value={aspectRatio}
                      onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-purple-500/50"
                    >
                      <option value="1:1">1:1 Square</option>
                      <option value="2:3">2:3 Portrait</option>
                      <option value="3:2">3:2 Landscape</option>
                      <option value="3:4">3:4 Classic</option>
                      <option value="4:3">4:3 Desktop</option>
                      <option value="9:16">9:16 Mobile</option>
                      <option value="16:9">16:9 Cinema</option>
                      <option value="21:9">21:9 UltraWide</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-[10px] uppercase tracking-widest font-bold text-white/40 ml-1">Resolution</label>
                    <select 
                      value={imageSize}
                      onChange={(e) => setImageSize(e.target.value as ImageSize)}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-purple-500/50"
                    >
                      <option value="1K">1K Quality</option>
                      <option value="2K">2K High Res</option>
                      <option value="4K">4K Ultra HD</option>
                    </select>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>

        {/* Error Message */}
        {error && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-8 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm flex items-start gap-3"
          >
            <X className="w-5 h-5 shrink-0 mt-0.5" onClick={() => setError(null)} />
            <p>{error}</p>
          </motion.div>
        )}

        {/* Gallery Grid */}
        <section className="grid grid-cols-2 gap-4">
          {images.length > 0 ? (
            images.map((image, idx) => (
              <motion.div
                key={image.id}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: idx * 0.1 }}
                onClick={() => setSelectedImage(image)}
                className={cn(
                  "relative rounded-2xl overflow-hidden cursor-pointer group border border-white/5 bg-white/5",
                  aspectRatio === "1:1" && "aspect-square",
                  aspectRatio === "9:16" && "aspect-[9/16]",
                  aspectRatio === "16:9" && "aspect-[16/9]",
                  aspectRatio === "3:4" && "aspect-[3/4]",
                  aspectRatio === "4:3" && "aspect-[4/3]",
                  aspectRatio === "2:3" && "aspect-[2/3]",
                  aspectRatio === "3:2" && "aspect-[3/2]",
                  aspectRatio === "21:9" && "aspect-[21/9]"
                )}
              >
                <img 
                  src={image.url} 
                  alt={image.prompt}
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                  referrerPolicy="no-referrer"
                />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <Maximize2 className="w-8 h-8 text-white/80" />
                </div>
              </motion.div>
            ))
          ) : !isGenerating && (
            <div className="col-span-2 py-20 flex flex-col items-center justify-center text-white/20 border-2 border-dashed border-white/5 rounded-3xl">
              <ImageIcon className="w-12 h-12 mb-4 opacity-50" />
              <p className="text-sm font-medium">Your creations will appear here</p>
            </div>
          )}

          {/* Loading Skeletons */}
          {isGenerating && images.length === 0 && Array(4).fill(null).map((_, i) => (
            <div 
              key={i} 
              className={cn(
                "rounded-2xl bg-white/5 border border-white/10 animate-pulse flex items-center justify-center",
                aspectRatio === "1:1" && "aspect-square",
                aspectRatio === "9:16" && "aspect-[9/16]",
                aspectRatio === "16:9" && "aspect-[16/9]",
                aspectRatio === "3:4" && "aspect-[3/4]",
                aspectRatio === "4:3" && "aspect-[4/3]",
                aspectRatio === "2:3" && "aspect-[2/3]",
                aspectRatio === "3:2" && "aspect-[3/2]",
                aspectRatio === "21:9" && "aspect-[21/9]"
              )}
            >
              <Loader2 className="w-6 h-6 text-white/10 animate-spin" />
            </div>
          ))}
        </section>
      </main>

      {/* Full Screen Modal */}
      <AnimatePresence>
        {selectedImage && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/95 flex flex-col p-6"
          >
            <div className="flex items-center justify-between mb-6">
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-widest font-bold text-white/40">Vibe</span>
                <h3 className="text-sm font-medium truncate max-w-[200px]">{selectedImage.prompt}</h3>
              </div>
              <button 
                onClick={() => setSelectedImage(null)}
                className="p-2 rounded-full bg-white/10 hover:bg-white/20 transition-colors"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="flex-1 relative rounded-3xl overflow-hidden shadow-2xl border border-white/10">
              <img 
                src={selectedImage.url} 
                alt={selectedImage.prompt}
                className="w-full h-full object-contain"
                referrerPolicy="no-referrer"
              />
            </div>

            <div className="mt-8 grid grid-cols-2 gap-4">
              <button
                onClick={() => handleDownload(selectedImage.url, selectedImage.id)}
                className="flex items-center justify-center gap-2 bg-white/10 hover:bg-white/20 border border-white/10 py-4 rounded-2xl transition-all font-bold"
              >
                <Download className="w-5 h-5" />
                <span>Download</span>
              </button>
              <button
                onClick={() => handleRemix(selectedImage)}
                className="flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-500 py-4 rounded-2xl transition-all font-bold shadow-[0_0_20px_rgba(147,51,234,0.3)]"
              >
                <RefreshCw className="w-5 h-5" />
                <span>Remix</span>
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer Info */}
      <footer className="fixed bottom-0 left-0 right-0 p-6 pointer-events-none">
        <div className="max-w-lg mx-auto flex justify-center">
          <p className="text-[10px] uppercase tracking-[0.3em] text-white/20 font-bold">
            Powered by Gemini 3.1 Flash
          </p>
        </div>
      </footer>
    </div>
  );
}
