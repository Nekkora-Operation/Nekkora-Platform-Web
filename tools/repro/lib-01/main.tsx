import { createRoot } from 'react-dom/client';
import { Input } from 'nekkora-lib';
import 'nekkora-lib/styles.css';
const out: string[] = [];
(window as any).__out = out;
window.addEventListener('error', (e) => out.push(`window.error: ${e.message}`));
function App() {
  return <Input type="file" label="Arquivo" accept=".zip" onChange={(e) => out.push(`onChange files=${e.target.files?.length ?? 0} name=${e.target.files?.[0]?.name ?? '-'}`)} />;
}
createRoot(document.getElementById('r')!).render(<App />);
