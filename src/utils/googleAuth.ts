import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/spreadsheets');
provider.addScope('https://www.googleapis.com/auth/drive.file');

const TOKEN_KEY = 'canbadge_google_access_token';
const TOKEN_TIME_KEY = 'canbadge_google_token_time';
let isSigningIn = false;
let cachedAccessToken: string | null =
  typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null;

export const isGoogleTokenExpired = (): boolean => {
  if (typeof window === 'undefined') return false;
  const savedTimeStr = localStorage.getItem(TOKEN_TIME_KEY);
  if (!savedTimeStr) return false;
  const savedTime = parseInt(savedTimeStr, 10);
  if (isNaN(savedTime)) return false;
  // 55 minutes (Google tokens expire in 60 minutes)
  return Date.now() - savedTime > 55 * 60 * 1000;
};

export const clearGoogleTokens = () => {
  cachedAccessToken = null;
  if (typeof window !== 'undefined') {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_TIME_KEY);
  }
};

export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (isGoogleTokenExpired()) {
        clearGoogleTokens();
        if (onAuthFailure) onAuthFailure();
        return;
      }
      const token = cachedAccessToken || localStorage.getItem(TOKEN_KEY);
      if (token) {
        cachedAccessToken = token;
        if (onAuthSuccess) onAuthSuccess(user, token);
      } else if (!isSigningIn) {
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      clearGoogleTokens();
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Google OAuth 인증 토큰을 받지 못했습니다.');
    }

    cachedAccessToken = credential.accessToken;
    localStorage.setItem(TOKEN_KEY, cachedAccessToken);
    localStorage.setItem(TOKEN_TIME_KEY, Date.now().toString());
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Google Sign in error:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  if (isGoogleTokenExpired()) {
    clearGoogleTokens();
    return null;
  }
  return cachedAccessToken || (typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null);
};

export const logoutGoogle = async () => {
  await auth.signOut();
  clearGoogleTokens();
};
