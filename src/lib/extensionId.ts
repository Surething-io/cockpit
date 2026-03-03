/** 全局存储 Chrome 扩展 ID（由扩展 background 轮询时注册） */
let registeredExtensionId: string | null = null;

export function setRegisteredExtensionId(id: string): void {
  registeredExtensionId = id;
}

export function getRegisteredExtensionId(): string | null {
  return registeredExtensionId;
}
