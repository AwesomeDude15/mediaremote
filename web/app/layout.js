import "./globals.css";

export const metadata = {
  title: "Remote",
  description: "Control what's playing on your laptop, from your phone.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
