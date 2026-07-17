export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${import.meta.env.BASE_URL}${path}`, {
    credentials: "same-origin",
    ...init,
  });
}
