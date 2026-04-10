import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import Stripe from "stripe";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { GoogleGenAI } from "@google/genai";
import firebaseConfig from "./firebase-applet-config.json" with { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin
const adminApp = admin.apps.length 
  ? admin.app() 
  : admin.initializeApp({
      projectId: firebaseConfig.projectId,
    });

const db = getFirestore(adminApp, firebaseConfig.firestoreDatabaseId);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Stripe initialization (lazy)
  let stripe: Stripe | null = null;
  const getStripe = () => {
    if (!stripe) {
      const key = process.env.STRIPE_SECRET_KEY;
      if (!key) throw new Error("STRIPE_SECRET_KEY is required");
      stripe = new Stripe(key);
    }
    return stripe;
  };

  // Gemini initialization (lazy)
  let genAI: GoogleGenAI | null = null;
  const getGenAI = () => {
    const key = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!key) return null;
    if (!genAI) {
      genAI = new GoogleGenAI({ apiKey: key });
    }
    return genAI;
  };

  // Stripe Webhook handler
  app.post("/api/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!sig || !webhookSecret) {
      console.error("Webhook Error: Missing signature or secret");
      return res.status(400).send("Webhook Error: Missing signature or secret");
    }

    let event;

    try {
      const stripeInstance = getStripe();
      event = stripeInstance.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err: any) {
      console.error(`Webhook Error: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id;
      const stripeCustomerId = session.customer as string;

      if (userId) {
        try {
          console.log(`Fulfilling subscription for user: ${userId}`);
          const userRef = db.collection("users").doc(userId);
          await userRef.update({
            isPro: true,
            stripeCustomerId: stripeCustomerId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log(`Successfully updated user ${userId} to Pro status`);
        } catch (error) {
          console.error(`Error updating user ${userId}:`, error);
        }
      }
    }

    res.json({ received: true });
  });

  app.use(express.json());

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/config", (req, res) => {
    res.json({
      hasGeminiKey: !!(process.env.GEMINI_API_KEY || process.env.API_KEY),
      hasStripeKey: !!process.env.STRIPE_SECRET_KEY
    });
  });

  app.post("/api/generate-wallpaper", async (req, res) => {
    try {
      const { prompt, aspectRatio, imageSize, referenceImage, isRemix } = req.body;
      const ai = getGenAI();
      
      if (!ai) {
        return res.status(400).json({ error: "Gemini API key not configured on server." });
      }

      const parts: any[] = [
        { text: prompt + (isRemix ? " (inspired by the reference image)" : "") }
      ];

      if (isRemix && referenceImage) {
        parts.unshift({
          inlineData: {
            data: referenceImage.split(',')[1],
            mimeType: "image/png"
          }
        });
      }

      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-image-preview",
        contents: { parts },
        config: {
          imageConfig: {
            aspectRatio,
            imageSize
          }
        }
      });

      const part = response.candidates?.[0]?.content?.parts?.[0];
      
      if (part?.inlineData) {
        res.json({ 
          data: part.inlineData.data,
          id: Math.random().toString(36).substring(7)
        });
      } else {
        throw new Error("No image data returned from model.");
      }
    } catch (error: any) {
      console.error("Generation error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/create-checkout-session", async (req, res) => {
    try {
      const { userId, userEmail } = req.body;
      const stripeInstance = getStripe();
      
      // Determine base URL dynamically if APP_URL is not set
      const protocol = req.headers["x-forwarded-proto"] || req.protocol;
      const host = req.headers["host"];
      const baseUrl = process.env.APP_URL || `${protocol}://${host}`;
      
      const session = await stripeInstance.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: "VibeWall Pro Subscription",
                description: "Unlimited high-quality wallpaper generations",
              },
              unit_amount: 999, // $9.99
              recurring: { interval: "month" },
            },
            quantity: 1,
          },
        ],
        mode: "subscription",
        success_url: `${baseUrl}/?success=true`,
        cancel_url: `${baseUrl}/?canceled=true`,
        client_reference_id: userId,
        customer_email: userEmail,
      });

      res.json({ url: session.url });
    } catch (error: any) {
      console.error("Stripe error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log("Environment check:");
    console.log("- GEMINI_API_KEY:", !!(process.env.GEMINI_API_KEY || process.env.API_KEY) ? "PRESENT" : "MISSING");
    console.log("- STRIPE_SECRET_KEY:", !!process.env.STRIPE_SECRET_KEY ? "PRESENT" : "MISSING");
    console.log("- STRIPE_WEBHOOK_SECRET:", !!process.env.STRIPE_WEBHOOK_SECRET ? "PRESENT" : "MISSING");
  });
}

startServer();
