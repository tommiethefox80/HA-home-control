// Stand-ins for a Home Assistant that's restarting: 'refuse' (nothing listening is done by not starting),
// '502' (proxy answers with an error), 'hang' (accepts the connection, never answers).
import { createServer } from 'node:http';
const mode = process.argv[2];
const srv = createServer((req, res) => { if (mode === '502') { res.writeHead(502); res.end('Bad gateway'); } });
srv.on('upgrade', (req, socket) => { if (mode === '502') { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } /* hang: do nothing */ });
srv.listen(8123, () => console.log('fake', mode));
