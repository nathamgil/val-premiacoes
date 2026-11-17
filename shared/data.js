/* VAL PREMIAÇÕES — camada de dados compartilhada entre o site e o painel (demo em localStorage).
   Mesma origem => cota reservada no site aparece no painel na hora (BroadcastChannel + storage event).
   Em produção vira Supabase + webhook do gateway Pix; a API abaixo é o contrato.
   Fonte dos preços: artes dos destaques do Instagram (17/11/2026):
   - "Rifa de grupo 10h 12h 15h 21h · Rifa de dezena 19h · Loteria Federal quarta e sábado"
   - "18:00 → 10/200 · 21:00 → 15/300" (cota/prêmio da rifa de grupo)
   - Federal: "R$ 20,00 para R$ 1.500,00", grade de 100 dezenas
   Valores marcados EXEMPLO precisam ser confirmados com o Val. */
(function () {
  const KEY = 'val_db_v1';
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('val_sync') : null;
  const listeners = [];

  const LOJA = {
    nome: 'Val Premiações', dono: 'Val Nascimento', slogan: 'Sorte tem quem acredita nela',
    instagram: 'val_premiacoes', whatsapp: '5571985288609', whatsappFmt: '(71) 98528-8609',
    cidade: 'Salvador', desde: 2021,
  };

  // 25 grupos, 4 dezenas cada (grupo 25 = 97, 98, 99, 00)
  const BICHOS = [
    ['Avestruz', '🦤'], ['Águia', '🦅'], ['Burro', '🫏'], ['Borboleta', '🦋'], ['Cachorro', '🐕'],
    ['Cabra', '🐐'], ['Carneiro', '🐏'], ['Camelo', '🐫'], ['Cobra', '🐍'], ['Coelho', '🐇'],
    ['Cavalo', '🐎'], ['Elefante', '🐘'], ['Galo', '🐓'], ['Gato', '🐈'], ['Jacaré', '🐊'],
    ['Leão', '🦁'], ['Macaco', '🐒'], ['Porco', '🐖'], ['Pavão', '🦚'], ['Peru', '🦃'],
    ['Touro', '🐂'], ['Tigre', '🐅'], ['Urso', '🐻'], ['Veado', '🦌'], ['Vaca', '🐄'],
  ].map(([nome, emoji], i) => {
    const g = i + 1;
    const dz = [0, 1, 2, 3].map(k => (g * 4 - 3 + k) % 100);
    return { g, nome, emoji, dezenas: dz };
  });
  const grupoDe = dezena => { const d = ((+dezena % 100) + 100) % 100; return d === 0 ? 25 : Math.ceil(d / 4); };

  const TIPOS = {
    grupo: { nome: 'Rifa de grupo', curto: 'Grupo', total: 25, regra: 'Ganha quem tiver o grupo (bicho) do 1º prêmio da extração da Bahia daquele horário.' },
    dezena: { nome: 'Rifa de dezena', curto: 'Dezena', total: 100, regra: 'Ganha quem tiver a dezena final do 1º prêmio da extração das 19h.' },
    federal: { nome: 'Rifa da Federal', curto: 'Federal', total: 100, regra: 'Ganha quem tiver a dezena final do 1º prêmio da Loteria Federal.' },
  };

  // agenda fixa (vira "modelo" editável no painel)
  const AGENDA = [
    { id: 'g10', tipo: 'grupo', hora: '10:00', dias: [0, 1, 2, 3, 4, 5, 6], cota: 10, premio: 200, extracao: 'PT-BA 10h' },
    { id: 'g12', tipo: 'grupo', hora: '12:00', dias: [0, 1, 2, 3, 4, 5, 6], cota: 10, premio: 200, extracao: 'PT-BA 12h' },
    { id: 'g15', tipo: 'grupo', hora: '15:00', dias: [0, 1, 2, 3, 4, 5, 6], cota: 10, premio: 200, extracao: 'PT-BA 15h' },
    { id: 'd19', tipo: 'dezena', hora: '19:00', dias: [0, 1, 2, 3, 4, 5, 6], cota: 15, premio: 1000, extracao: 'PT-BA 19h', exemplo: true },
    { id: 'g21', tipo: 'grupo', hora: '21:00', dias: [0, 1, 2, 3, 4, 5, 6], cota: 15, premio: 300, extracao: 'PT-BA 21h' },
    { id: 'fed', tipo: 'federal', hora: '19:00', dias: [3, 6], cota: 20, premio: 1500, extracao: 'Loteria Federal' },
  ];

  const CONFIG = {
    reservaMin: 10, encerraAntesMin: 10,
    pix: { gateway: 'mercadopago', conectado: false, conta: '', chave: '', nomeRecebedor: 'VAL PREMIACOES', cidade: 'SALVADOR' },
    grupoVip: 'https://wa.me/5571985288609?text=' + encodeURIComponent('Oi Val! Quero entrar na lista VIP de transmissão 🍀'),
    avisoWhats: true,
  };

  /* ---------- util ---------- */
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const uid = p => p + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6);
  const brl = v => 'R$ ' + (+v).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const brl0 = v => (+v % 1 ? brl(v) : 'R$ ' + String(+v).replace(/\B(?=(\d{3})+(?!\d))/g, '.'));
  const soDig = s => String(s || '').replace(/\D/g, '');
  const fmtTel = s => { const d = soDig(s).replace(/^55/, ''); return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}` : s; };
  const numFmt = (tipo, n) => tipo === 'grupo' ? pad(n) : pad(n);
  // gerador pseudoaleatório com semente (demo estável)
  function rng(seed) { let s = seed >>> 0 || 1; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
  const hashStr = s => { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

  const NOMES = ['Iran', 'Lucas', 'Alessandra', 'Jorginho', 'Helen', 'Zé', 'Marcos', 'Tati', 'Rafa', 'Dona Cida', 'Binho', 'Josi', 'Edson', 'Paulinha', 'Neto', 'Cris', 'Duda', 'Gil', 'Mari', 'Robson', 'Léo', 'Nalva', 'Kel', 'Fabinho', 'Rose', 'Beto', 'Lu', 'Tonho', 'Vânia', 'Dinho'];
  const SOBRE = ['Santos', 'Silva', 'Souza', 'Oliveira', 'Nascimento', 'Conceição', 'Jesus', 'Lima', 'Bonfim', 'Ribeiro'];

  /* ---------- sorteios ---------- */
  function horarioDe(r) { const [h, m] = r.hora.split(':').map(Number); const d = new Date(r.data + 'T00:00:00'); d.setHours(h, m, 0, 0); return d; }
  function fechaEm(r, cfg) { return new Date(+horarioDe(r) - (cfg || CONFIG).encerraAntesMin * 60e3); }

  function criaSorteio(modelo, data) {
    return {
      id: `${data}-${modelo.id}`, modelo: modelo.id, tipo: modelo.tipo, data, hora: modelo.hora,
      cota: modelo.cota, premio: modelo.premio, total: TIPOS[modelo.tipo].total, extracao: modelo.extracao,
      status: 'aberta', resultado: null, numeroSorteado: null, ganhadorPedido: null, apuradoEm: null, pagoPremio: false,
      premioDesc: modelo.premioDesc || '',
    };
  }

  // garante os sorteios de hoje e dos próximos dias (Federal: próxima quarta/sábado)
  function garanteAgenda(db) {
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    let mudou = false;
    for (let k = 0; k <= 4; k++) {
      const d = new Date(+hoje + k * 864e5); const dia = d.getDay(); const data = ymd(d);
      for (const m of db.agenda) {
        if (!m.ativo && m.ativo !== undefined) continue;
        if (!m.dias.includes(dia)) continue;
        if (m.tipo !== 'federal' && k > 1) continue; // diárias: hoje e amanhã
        const id = `${data}-${m.id}`;
        if (!db.sorteios.find(s => s.id === id)) { db.sorteios.push(criaSorteio(m, data)); mudou = true; }
      }
    }
    return mudou;
  }

  function atualizaStatus(db) {
    const agora = Date.now(); let mudou = false;
    for (const s of db.sorteios) {
      if (s.status === 'aberta' && agora >= +fechaEm(s, db.config)) { s.status = 'encerrada'; mudou = true; }
    }
    for (const p of db.pedidos) {
      if (p.status === 'reservado' && agora - +new Date(p.criado) > db.config.reservaMin * 60e3) { p.status = 'expirado'; p.hist.push({ s: 'expirado', t: new Date().toISOString() }); mudou = true; }
    }
    return mudou;
  }

  /* ---------- demo ---------- */
  function seed() {
    const db = { v: 1, loja: LOJA, config: JSON.parse(JSON.stringify(CONFIG)), agenda: JSON.parse(JSON.stringify(AGENDA)).map(a => ({ ...a, ativo: true })), sorteios: [], pedidos: [], log: [], demo: true };
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const R = rng(hashStr(ymd(hoje)));
    const nomeR = () => `${NOMES[Math.floor(R() * NOMES.length)]} ${SOBRE[Math.floor(R() * SOBRE.length)]}`;
    const telR = () => '5571' + (9 * 1e7 + Math.floor(R() * 9e7));
    const clientes = Array.from({ length: 46 }, () => ({ nome: nomeR(), tel: telR() }));

    // passado: 6 dias, tudo apurado
    for (let k = 6; k >= 1; k--) {
      const d = new Date(+hoje - k * 864e5); const data = ymd(d);
      for (const m of db.agenda) {
        if (!m.dias.includes(d.getDay())) continue;
        const s = criaSorteio(m, data); db.sorteios.push(s);
        vendeAleatorio(db, s, R, clientes, 0.72 + R() * 0.26, +horarioDe(s) - 20 * 36e5, +horarioDe(s) - 15 * 6e4);
        const milhar = pad(Math.floor(R() * 10000), 4);
        apuraInterno(db, s, milhar, +horarioDe(s) + 25 * 6e4);
        s.pagoPremio = !!s.ganhadorPedido;
      }
    }
    // hoje e próximos
    garanteAgenda(db);
    const agora = Date.now();
    for (const s of db.sorteios.filter(x => x.status === 'aberta' && x.data >= ymd(hoje))) {
      const h = +horarioDe(s); const ate = Math.min(agora - 3 * 6e4, h - 12 * 6e4);
      const ini = h - (s.tipo === 'federal' ? 3.2 * 864e5 : 18 * 36e5);
      const passou = h - 10 * 6e4 <= agora;
      const frac = passou ? 0.8 + R() * 0.2 : s.data === ymd(hoje) ? 0.35 + R() * 0.45 : 0.1 + R() * 0.2;
      if (ate > ini) vendeAleatorio(db, s, R, clientes, frac, ini, ate);
    }
    // alguns pendentes (reservados agora) para o painel ter o que conferir
    const abertas = db.sorteios.filter(s => s.status === 'aberta' && agora < +fechaEm(s, db.config));
    for (let i = 0; i < Math.min(3, abertas.length); i++) {
      const s = abertas[i]; const livres = livresDe(db, s);
      if (!livres.length) continue;
      const c = clientes[Math.floor(R() * clientes.length)];
      const nums = [livres[Math.floor(R() * livres.length)]];
      novoPedido(db, s, nums, c.nome, c.tel, agora - (2 + i * 2) * 6e4, 'reservado');
    }
    atualizaStatus(db);
    return db;
  }

  function vendeAleatorio(db, s, R, clientes, frac, t0, t1) {
    const alvo = Math.round(s.total * Math.min(1, frac));
    let livres = livresDe(db, s);
    while (s.total - livres.length < alvo && livres.length) {
      const c = clientes[Math.floor(R() * clientes.length)];
      const q = Math.min(livres.length, R() < 0.6 ? 1 : R() < 0.75 ? 2 : 3);
      const nums = [];
      for (let i = 0; i < q; i++) nums.push(livres.splice(Math.floor(R() * livres.length), 1)[0]);
      const t = t0 + R() * (t1 - t0);
      novoPedido(db, s, nums.sort((a, b) => a - b), c.nome, c.tel, t, 'pago');
    }
  }

  function novoPedido(db, s, nums, nome, tel, t, status) {
    const p = {
      id: 'VP' + String(1000 + db.pedidos.length + Math.floor(Math.random() * 9)).slice(-4) + Math.random().toString(36).slice(2, 4).toUpperCase(),
      sorteio: s.id, nums, nome, tel: soDig(tel), valor: nums.length * s.cota, status,
      criado: new Date(t).toISOString(), pagoEm: status === 'pago' ? new Date(t + 40e3).toISOString() : null,
      txid: 'VAL' + Math.random().toString(36).slice(2, 12).toUpperCase(), canal: 'site',
      hist: [{ s: 'reservado', t: new Date(t).toISOString() }].concat(status === 'pago' ? [{ s: 'pago', t: new Date(t + 40e3).toISOString(), por: 'Pix automático' }] : []),
    };
    db.pedidos.push(p); return p;
  }

  function ocupados(db, s) {
    const m = {};
    for (const p of db.pedidos) if (p.sorteio === s.id && (p.status === 'pago' || p.status === 'reservado')) for (const n of p.nums) m[n] = { status: p.status, pedido: p.id, nome: p.nome };
    return m;
  }
  const numeros = s => s.tipo === 'grupo' ? Array.from({ length: 25 }, (_, i) => i + 1) : Array.from({ length: 100 }, (_, i) => i);
  function livresDe(db, s) { const o = ocupados(db, s); return numeros(s).filter(n => !o[n]); }

  // resultado: milhar do 1º prêmio. Grupo usa o bicho; dezena/federal usam os 2 últimos dígitos.
  function apuraInterno(db, s, milhar, t) {
    const m = soDig(milhar).slice(-5).padStart(4, '0');
    const dez = +m.slice(-2); const g = grupoDe(dez);
    s.resultado = m; s.numeroSorteado = s.tipo === 'grupo' ? g : dez;
    const o = ocupados(db, s); const dono = o[s.numeroSorteado];
    s.ganhadorPedido = dono && dono.status === 'pago' ? dono.pedido : null;
    s.status = 'apurada'; s.apuradoEm = new Date(t || Date.now()).toISOString();
    // reservas não pagas morrem na apuração
    for (const p of db.pedidos) if (p.sorteio === s.id && p.status === 'reservado') { p.status = 'expirado'; p.hist.push({ s: 'expirado', t: s.apuradoEm }); }
    return s;
  }

  /* ---------- Pix (BR Code estático, padrão EMV do Banco Central) ---------- */
  function crc16(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }
  const tlv = (id, v) => id + pad(String(v).length) + v;
  function pixPayload(valor, txid, cfg) {
    const c = (cfg || CONFIG).pix;
    const chave = c.chave || '123e4567-e89b-42d3-a456-426614174000'; // chave aleatória de DEMONSTRAÇÃO
    const sem = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, '');
    let p = tlv('00', '01') + tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('01', chave)) + tlv('52', '0000') + tlv('53', '986') +
      tlv('54', (+valor).toFixed(2)) + tlv('58', 'BR') + tlv('59', sem(c.nomeRecebedor).slice(0, 25)) + tlv('60', sem(c.cidade).slice(0, 15)) +
      tlv('62', tlv('05', String(txid).replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***'));
    p += '6304';
    return p + crc16(p);
  }

  /* ---------- persistência ---------- */
  let cache = null;
  function load() {
    if (cache) return cache;
    try { cache = JSON.parse(localStorage.getItem(KEY)); } catch (e) { cache = null; }
    if (!cache || cache.v !== 1) { cache = seed(); persist(); }
    const a = garanteAgenda(cache), b = atualizaStatus(cache);
    if (a || b) persist();
    return cache;
  }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { } }
  function emit(src) { listeners.forEach(f => { try { f(src); } catch (e) { console.error(e); } }); }
  function save(fn, quiet) {
    const db = load(); fn && fn(db); persist();
    if (bc && !quiet) bc.postMessage('chg');
    emit('local');
    return db;
  }
  function reload() { cache = null; return load(); }
  if (bc) bc.onmessage = () => { reload(); emit('remote'); };
  window.addEventListener('storage', e => { if (e.key === KEY) { reload(); emit('remote'); } });
  setInterval(() => { const db = load(); if (atualizaStatus(db) | garanteAgenda(db)) { persist(); emit('tick'); } }, 15e3);

  /* ---------- API pública ---------- */
  window.VAL = {
    LOJA, BICHOS, TIPOS, grupoDe, brl, brl0, pad, ymd, fmtTel, soDig, numFmt,
    db: load, save, reload, on: f => listeners.push(f),
    reset() { localStorage.removeItem(KEY); cache = null; load(); if (bc) bc.postMessage('chg'); emit('local'); },
    horario: horarioDe, fecha: s => fechaEm(s, load().config), numeros,
    ocupados: s => ocupados(load(), s), livres: s => livresDe(load(), s),
    sorteio: id => load().sorteios.find(s => s.id === id),
    abertos() { const db = load(); const ag = Date.now(); return db.sorteios.filter(s => s.status === 'aberta' && ag < +fechaEm(s, db.config)).sort((a, b) => horarioDe(a) - horarioDe(b)); },
    apurados(n) { return load().sorteios.filter(s => s.status === 'apurada').sort((a, b) => horarioDe(b) - horarioDe(a)).slice(0, n || 999); },
    pedido: id => load().pedidos.find(p => p.id === id),
    pedidosDoTel(tel) { const t = soDig(tel).replace(/^55/, ''); return load().pedidos.filter(p => p.tel.replace(/^55/, '').endsWith(t) && t.length >= 8).sort((a, b) => new Date(b.criado) - new Date(a.criado)); },
    // reserva atômica: falha se algum número já foi pego
    reservar(sorteioId, nums, nome, tel) {
      let out = null;
      save(db => {
        atualizaStatus(db);
        const s = db.sorteios.find(x => x.id === sorteioId);
        if (!s || s.status !== 'aberta') { out = { erro: 'Esse sorteio já fechou.' }; return; }
        const o = ocupados(db, s); const pegos = nums.filter(n => o[n]);
        if (pegos.length) { out = { erro: 'conflito', pegos }; return; }
        const t = soDig(tel); out = { pedido: novoPedido(db, s, nums.slice().sort((a, b) => a - b), nome.trim(), t.length <= 11 ? '55' + t : t, Date.now(), 'reservado') };
      });
      return out;
    },
    confirmarPagamento(id, por) {
      let p; save(db => { p = db.pedidos.find(x => x.id === id); if (!p || p.status === 'pago') return; p.status = 'pago'; p.pagoEm = new Date().toISOString(); p.hist.push({ s: 'pago', t: p.pagoEm, por: por || 'Pix automático' }); });
      return p;
    },
    cancelar(id, motivo) { save(db => { const p = db.pedidos.find(x => x.id === id); if (!p) return; p.status = 'cancelado'; p.hist.push({ s: 'cancelado', t: new Date().toISOString(), por: motivo || 'painel' }); }); },
    apurar(id, milhar) { let s; save(db => { s = db.sorteios.find(x => x.id === id); if (s) apuraInterno(db, s, milhar); db.log.push({ t: new Date().toISOString(), o: 'apurou ' + id + ' → ' + milhar }); }); return s; },
    pixPayload: (v, txid) => pixPayload(v, txid, load().config),
    validade: p => new Date(+new Date(p.criado) + load().config.reservaMin * 60e3),
  };
})();
