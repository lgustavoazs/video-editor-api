import { useEffect, useState } from "react";
import { api, ApiError } from "./api.ts";
import { Login } from "./Login.tsx";
import { MyVideos } from "./MyVideos.tsx";
import { NewVideo } from "./NewVideo.tsx";

type Tab = "novo" | "meus";

export function App() {
  const [state, setState] = useState<"loading" | "login" | "disabled" | "ready" | "offline">("loading");
  const [tab, setTab] = useState<Tab>("novo");
  /** Muda quando um vídeo novo é criado, para a lista recarregar. */
  const [created, setCreated] = useState(0);

  const check = () => {
    api
      .session()
      .then((s) => setState(!s.enabled ? "disabled" : s.authenticated ? "ready" : "login"))
      .catch(() => setState("offline"));
  };
  useEffect(check, []);

  // Sessão expirada no meio do uso: qualquer 401 volta para o login.
  useEffect(() => {
    const onError = (e: PromiseRejectionEvent) => {
      if (e.reason instanceof ApiError && e.reason.status === 401) setState("login");
    };
    window.addEventListener("unhandledrejection", onError);
    return () => window.removeEventListener("unhandledrejection", onError);
  }, []);

  if (state === "loading") return <div className="center muted">Carregando…</div>;
  if (state === "offline")
    return (
      <div className="center">
        <p>Não foi possível falar com o servidor.</p>
        <button onClick={check}>Tentar de novo</button>
      </div>
    );
  if (state === "disabled")
    return (
      <div className="center">
        <p>O acesso pelo site está desativado neste servidor.</p>
        <p className="muted small">Defina SITE_PASSWORD (mínimo de 8 caracteres) nas variáveis da Railway.</p>
      </div>
    );
  if (state === "login") return <Login onDone={() => setState("ready")} />;

  return (
    <div className="app">
      <header className="topbar">
        <strong className="brand">Editor de Vídeo</strong>
        <nav className="tabs">
          <button className={tab === "novo" ? "tab active" : "tab"} onClick={() => setTab("novo")}>
            Novo vídeo
          </button>
          <button className={tab === "meus" ? "tab active" : "tab"} onClick={() => setTab("meus")}>
            Meus vídeos
          </button>
        </nav>
        <button
          className="link"
          onClick={() => {
            void api.logout().finally(() => setState("login"));
          }}
        >
          Sair
        </button>
      </header>
      <main>
        {/* A tela de novo vídeo fica montada ao trocar de aba, para não perder o que foi preenchido. */}
        <div hidden={tab !== "novo"}>
          <NewVideo
            onCreated={() => setCreated((n) => n + 1)}
            onShowList={() => setTab("meus")}
          />
        </div>
        {tab === "meus" && <MyVideos refreshKey={created} />}
      </main>
    </div>
  );
}
