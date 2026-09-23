import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

export interface User {
  id: string;
  email: string;
  role: "admin" | "investor";
  firstName: string;
  lastName: string;
  createdAt: string;
}

export type LoginResult = { success: true; user: User } | { success: false; error: string };

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  refetch: () => Promise<void>;
}

type SessionRequest = (url: string, init: RequestInit) => Promise<Response>;

/** Drops React Query data cached for the previous account so the next account
 * never sees it. AuthProvider renders only inside AppProviders, which already
 * loaded this module; importing it lazily keeps React Query out of the tenant
 * and applicant first-page bundle. */
async function forgetCachedQueries(): Promise<void> {
  try {
    (await import("@/lib/queryClient")).queryClient.clear();
  } catch {
    // Nothing was cached if the module cannot load.
  }
}

export async function signInWebsite(email: string, password: string, request: SessionRequest = fetch): Promise<LoginResult> {
  try {
    const response = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    let data: { user?: User; message?: string };
    try {
      data = await response.json();
    } catch {
      return { success: false, error: "Login service unavailable" };
    }
    if (response.ok && data.user) return { success: true, user: data.user };
    return { success: false, error: data.message || "Login failed" };
  } catch {
    return { success: false, error: "Login service unavailable" };
  }
}

/** Ends the website session and forgets cached account data. It never rejects:
 * the local sign-out happens even when the server cannot be reached. */
export async function endWebsiteSession(request: SessionRequest = fetch, forget: () => Promise<void> = forgetCachedQueries): Promise<void> {
  try {
    await request("/api/auth/logout", { method: "POST", credentials: "include" });
  } catch {
    // The server session expires on its own.
  }
  await forget();
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchUser = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/me", {
        credentials: "include",
      });
      if (response.ok) {
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const data = await response.json();
          setUser(data.user);
        } else {
          setUser(null);
        }
      } else {
        setUser(null);
      }
    } catch (error) {
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const login = async (email: string, password: string): Promise<LoginResult> => {
    const result = await signInWebsite(email, password);
    if (result.success) {
      await forgetCachedQueries();
      setUser(result.user);
    }
    return result;
  };

  const logout = async () => {
    await endWebsiteSession();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout, refetch: fetchUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
