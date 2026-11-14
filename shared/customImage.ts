export const CUSTOM_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CUSTOM_IMAGE_SIZE = 256;
export const CUSTOM_IMAGE_MAX_DATA_LENGTH = 600_000;

export function fitSquare(width: number, height: number, max = CUSTOM_IMAGE_SIZE) {
  const scale = Math.min(1, max / Math.max(width, height, 1));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function isSafeCustomImage(value: string): boolean {
  return value.length <= CUSTOM_IMAGE_MAX_DATA_LENGTH
    && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(value);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('图片读取失败，请重试'));
    reader.readAsDataURL(file);
  });
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('这张图片无法解析，请换一张'));
    image.src = source;
  });
}

export async function fileToCustomImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  if (file.size > CUSTOM_IMAGE_MAX_BYTES) throw new Error('图片不能超过 5 MB');
  const image = await loadImage(await readAsDataUrl(file));
  const { width, height } = fitSquare(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器不支持图片处理');
  context.drawImage(image, 0, 0, width, height);
  const result = canvas.toDataURL('image/png');
  if (!isSafeCustomImage(result)) throw new Error('图片细节过多，请换一张更简洁的图片');
  return result;
}
