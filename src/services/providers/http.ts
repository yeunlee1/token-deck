// 공급사 API의 오류 본문을 보존하는 공통 HTTP 유틸리티
export class ProviderApiError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly responseBody: unknown,
  ) {
    super(`${provider} API 요청 실패 (${status})`);
    this.name = "ProviderApiError";
  }
}

export async function fetchJson<T>(
  provider: string,
  request: typeof fetch,
  input: string,
  init: RequestInit,
): Promise<T> {
  const response = await request(input, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!response.ok) throw new ProviderApiError(provider, response.status, body);
  return body as T;
}
