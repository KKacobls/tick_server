import React from "react";
import { Text, View } from "react-native";
import Svg, { Rect } from "react-native-svg";
import QRCode from "react-native-qrcode-svg";

// ISO/IEC 15417 Code 128 bar/space widths for symbols 0..106.
const P = [
"212222","222122","222221","121223","121322","131222","122213","122312","132212","221213","221312","231212",
"112232","122132","122231","113222","123122","123221","223211","221132","221231","213212","223112","312131",
"311222","321122","321221","312212","322112","322211","212123","212321","232121","111323","131123","131321",
"112313","132113","132311","211313","231113","231311","112133","112331","132131","113123","113321","133121",
"313121","211331","231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
"314111","221411","431111","111224","111422","121124","121421","141122","141221","112214","112412","122114",
"122411","142112","142211","241211","221114","413111","241112","134111","111242","121142","121241","114212",
"124112","124211","411212","421112","421211","212141","214121","412121","111143","111341","131141","114113",
"114311","411113","411311","113141","114131","311141","411131","211412","211214","211232","2331112"
];

function Code128({ value }) {
  if (!/^[\x20-\x7e]+$/.test(value)) return <Text>此內容不支援一維 Code128，請改用 QR Code</Text>;
  const codes = [104, ...[...value].map(c => c.charCodeAt(0) - 32)];
  let checksum = 104;
  codes.slice(1).forEach((code, i) => { checksum += code * (i + 1); });
  codes.push(checksum % 103, 106);
  let x = 10;
  const bars = [];
  for (const code of codes) {
    const pattern = P[code];
    for (let i = 0; i < pattern.length; i++) {
      const width = Number(pattern[i]);
      if (i % 2 === 0) bars.push(<Rect key={bars.length} x={x} y={0} width={width} height={64} fill="black" />);
      x += width;
    }
  }
  const full = x + 10;
  return <Svg width="100%" height={80} viewBox={"0 0 " + full + " 74"}>
    <Rect x={0} y={0} width={full} height={74} fill="white" />
    {bars}
  </Svg>;
}

export default function Barcode({ value, mode = "qr" }) {
  if (!value) return null;
  return <View style={{ alignItems: "center", backgroundColor: "white", padding: 12, borderRadius: 12, marginVertical: 6 }}>
    {mode === "barcode"
      ? <Code128 value={value} />
      : <QRCode value={value} size={178} backgroundColor="white" color="black" />}
    <Text selectable style={{ color: "#101b2a", marginTop: 7, fontSize: 14, fontWeight: "700", textAlign: "center" }}>{value}</Text>
  </View>;
}
