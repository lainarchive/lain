let token = "";

export function captureToken(
  hash: string,
  storage: Pick<Storage, "getItem" | "setItem">,
  stripHash: () => void,
) {
  const supplied = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  try {
    if (supplied) storage.setItem("lain-dashboard-token", supplied);
    token = supplied ?? storage.getItem("lain-dashboard-token") ?? "";
  } catch {
    token = supplied ?? token;
  }
  if (supplied !== null) stripHash();
  return token;
}

export function dashboardToken() {
  return captureToken(location.hash, sessionStorage, () => {
    history.replaceState(null, "", location.pathname + location.search);
  });
}

export function authorizedHeaders(token: string, init?: HeadersInit) {
  const headers = new Headers(init);
  headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

export function websocketProtocols(token: string) {
  return ["lain-dashboard", `lain-token.${token}`];
}
