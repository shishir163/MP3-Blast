// এখানে নিজের Firebase প্রকল্পের তথ্য বসাও (ধাপগুলো SETUP-bn.md ফাইলে আছে)।
// Firebase কনসোল → প্রকল্পের সেটিংস → Your apps → Web app → firebaseConfig
export const firebaseConfig = {
  apiKey: "AIzaSyCpP1qA2Y81yOfb0xhAhU1YpmQfzY6Vpk4",
  authDomain: "mp3-blast.firebaseapp.com",
  projectId: "mp3-blast",
  storageBucket: "mp3-blast.firebasestorage.app",
  messagingSenderId: "145293097897",
  appId: "1:145293097897:web:a1fdbeb2b9eec931aa62b8",
};

// ড্রাইভ থেকে শুধু গান পড়ার অনুমতি। পরের ধাপে নাম বদলের সময় এটি বদলে
// "https://www.googleapis.com/auth/drive" হবে।
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
