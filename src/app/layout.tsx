import './global.css';

export const metadata = {
  title: 'Picklebook Chat Agent',
  description: 'Pickleball court availability chat assistant',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
