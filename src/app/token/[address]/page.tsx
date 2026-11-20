import Studio from '../../studio';
export default async function TokenPage({ params }: { params: Promise<{ address: string }> }) { const { address } = await params; return <Studio section="token" tokenAddress={address} />; }
