import dotenv from "dotenv";

dotenv.config({
  path: process.env.NODE_ENV === "test" ? ".env.test" : ".env"
});

const shouldSuppressLibsignalNoise = (args: unknown[]): boolean => {
  const text = args
    .map(item => {
      if (typeof item === "string") return item;
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .join(" ");

  return (
    text.includes("Closing stale open session for new outgoing prekey bundle") ||
    text.includes("Closing session: SessionEntry") ||
    text.includes("Removing old closed session: SessionEntry")
  );
};

const installLibsignalLogFilter = () => {
  // Em produção, reduz ruído de logs internos do libsignal/Baileys.
  if (process.env.NODE_ENV !== "production") return;

  const originalConsoleLog = console.log.bind(console);
  const originalConsoleInfo = console.info.bind(console);

  console.log = (...args: unknown[]) => {
    if (shouldSuppressLibsignalNoise(args)) return;
    originalConsoleLog(...args);
  };

  console.info = (...args: unknown[]) => {
    if (shouldSuppressLibsignalNoise(args)) return;
    originalConsoleInfo(...args);
  };
};

installLibsignalLogFilter();
