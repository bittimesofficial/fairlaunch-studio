import Studio from '../studio';
export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) { const { section } = await params; return <Studio section={section} />; }
