const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const sizes = [72, 96, 128, 144, 152, 192, 384, 512];
const outputDir = path.join(__dirname, '../public/icons');

// 创建驾驶舱图标 SVG - 体现"掌控万物"的意境
// 设计：黑底圆角方形 - C 形弧线（开口向下）+ 中心控制点，象征 Cockpit 品牌 + 保护/掌控
const createIconSvg = (size) => {
  const cx = size / 2;
  const cy = size / 2;
  const bgSize = size * 0.9;      // 背景方形大小
  const bgRadius = size * 0.18;   // 圆角半径
  const cRadius = size * 0.28;    // C 形弧线半径
  const strokeWidth = size * 0.06; // C 形线条粗细

  // C 形弧线：开口向下，从左下到右下画弧（约 270 度）
  const startAngle = 135 * (Math.PI / 180);  // 左下 135°
  const endAngle = 45 * (Math.PI / 180);     // 右下 45°

  const startX = cx + cRadius * Math.cos(startAngle);
  const startY = cy + cRadius * Math.sin(startAngle);
  const endX = cx + cRadius * Math.cos(endAngle);
  const endY = cy + cRadius * Math.sin(endAngle);

  const bgOffset = (size - bgSize) / 2;

  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <!-- 圆角方形黑色背景 -->
      <rect x="${bgOffset}" y="${bgOffset}" width="${bgSize}" height="${bgSize}" rx="${bgRadius}" ry="${bgRadius}" fill="#18181b"/>

      <!-- C 形弧线 - 开口向下 -->
      <path
        d="M ${startX} ${startY} A ${cRadius} ${cRadius} 0 1 1 ${endX} ${endY}"
        fill="none"
        stroke="#ffffff"
        stroke-width="${strokeWidth}"
        stroke-linecap="round"
      />

      <!-- 中心控制点 - 发光效果 -->
      <circle cx="${cx}" cy="${cy}" r="${size * 0.08}" fill="#ffffff" opacity="0.3"/>
      <circle cx="${cx}" cy="${cy}" r="${size * 0.05}" fill="#ffffff"/>
    </svg>
  `;
};

async function generateIcons() {
  // 确保输出目录存在
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const size of sizes) {
    const svg = createIconSvg(size);
    const outputPath = path.join(outputDir, `icon-${size}x${size}.png`);

    await sharp(Buffer.from(svg))
      .resize(size, size)
      .png()
      .toFile(outputPath);

    console.log(`Generated: icon-${size}x${size}.png`);
  }

  // 生成 favicon
  const faviconSvg = createIconSvg(32);
  await sharp(Buffer.from(faviconSvg))
    .resize(32, 32)
    .png()
    .toFile(path.join(outputDir, '../favicon.ico'));

  console.log('Generated: favicon.ico');
  console.log('All icons generated successfully!');
}

generateIcons().catch(console.error);
