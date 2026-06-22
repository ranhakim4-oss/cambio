const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const rooms = {};

// ── Card helpers ──────────────────────────────────────────────
const SUITS = ['♠','♥','♦','♣'];
const VALS  = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

function pts(c) {
  if (!c) return 0; if (c.jk) return 0;
  if (c.v==='K'&&(c.s==='♥'||c.s==='♦')) return -1;
  if (c.v==='A') return 1; if (c.v==='J') return 11;
  if (c.v==='Q') return 12; if (c.v==='K') return 13;
  return parseInt(c.v);
}
function isRed(c) { return c&&!c.jk&&(c.s==='♥'||c.s==='♦'); }
function isSp(c)  { if(!c||c.jk)return false; return ['7','8','9','10','J','Q','K'].includes(c.v); }
function shuffle(a) {
  let b=[...a];
  for(let i=b.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]];}
  return b;
}
function buildDeck() {
  let d=[];
  for(let s of SUITS)for(let v of VALS)d.push({v,s,jk:false});
  d.push({v:'JK',s:'',jk:true}); d.push({v:'JK',s:'',jk:true});
  return shuffle(d);
}
function cardName(c) { if(!c)return'?'; if(c.jk)return"ג'וקר"; return c.v+c.s; }
function genCode() {
  const ch='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s=''; for(let i=0;i<4;i++)s+=ch[Math.floor(Math.random()*ch.length)]; return s;
}

// ── State broadcast ───────────────────────────────────────────
// FIX #1: each card is visible only to the player who is currently peeking it (peekerPi)
// FIX #2: status is personalized — "your turn" only goes to the current player
function stateFor(room, socketId) {
  const g = room.game;
  if (!g) return null;
  const myIdx = room.players.findIndex(p=>p.id===socketId);
  const isCurMe = myIdx === g.cur;

  return {
    players: g.players.map((p,pi)=>({
      name: p.name,
      isAI: p.isAI,
      cardCount: p.cards.length,
      // Show card only if myIdx is the one peeking it (or game over)
      cards: p.cards.map((c,ci)=>{
        if (g.over) return c;
        if (p.peeking[ci] && p.peeker[ci] === myIdx) return c;
        return null;
      }),
      // peeking[ci] = true only if I (myIdx) am peeking that card
      peeking: p.cards.map((_,ci)=> p.peeking[ci] && p.peeker[ci] === myIdx),
    })),
    myIdx,
    cur: g.cur,
    phase: g.phase,
    disc: g.disc,
    deckCount: g.deck.length,
    drawn: isCurMe ? g.drawn : (g.drawn ? true : null),
    cambio: g.cambio,
    cambioWho: g.cambioWho,
    over: g.over,
    scores: g.scores||null,
    spData: g.spData,
    snapData: g.snapData,
    // Personalized status
    status: (() => {
      if (isCurMe || g.over) return g.status;
      const turn = ['התורך','שלוף קלף','בחר קלף','החלף','הצץ','הציץ','קמביו'];
      if (turn.some(w=>g.status.includes(w)))
        return `תור של ${g.players[g.cur]?.name||''}...`;
      return g.status;
    })(),
    statusCls: g.statusCls,
    log: g.log,
    snapUsed: g.snapUsed,
    peeksLeft: myIdx>=0 ? (g.peeksLeft[myIdx]||0) : 0,
    peeksDone: g.peeksDone ? [...g.peeksDone] : [],
  };
}

function broadcast(room) {
  if (!room.game) return;
  room.players.forEach(p=>{
    if (p.id && !p.isAI) io.to(p.id).emit('state', stateFor(room, p.id));
  });
}

// Send flying card animation to all clients
function sendAnim(room, fromId, toId, label, red) {
  io.to(room.code).emit('anim', {fromId, toId, label, red:!!red});
}

function setSt(g,msg,cls=''){g.status=msg;g.statusCls=cls;}
function addLog(g,msg){g.log=msg;}

// ── Room helpers ──────────────────────────────────────────────
function findRoomByPlayer(socketId) {
  return Object.values(rooms).find(r=>r.players.some(p=>p.id===socketId));
}

// ── Game init ─────────────────────────────────────────────────
function initGame(room) {
  const deck = buildDeck();
  const players = room.players.map(p=>({
    name: p.name,
    isAI: p.isAI||false,
    socketId: p.id||null,
    cards: [deck.pop(),deck.pop(),deck.pop(),deck.pop()],
    peeking: [false,false,false,false],
    peeker:  [null, null, null, null],   // who is peeking each card
  }));

  const peeksLeft = {};
  players.forEach((p,i)=>{ peeksLeft[i] = p.isAI ? 0 : 2; });

  room.game = {
    deck, disc:[deck.pop()], players, np:players.length,
    cur:0, phase:'peek', drawn:null,
    peeksLeft, peeksDone: new Set(),
    spData:{}, snapData:{},
    cambio:false, cambioWho:-1, turnsAfter:0,
    over:false, snapUsed:false,
    status:'התחלנו! כל שחקן מציץ ב-2 קלפים הקרובים אליו.',
    statusCls:'action', log:'', scores:null,
  };

  players.forEach((_,i)=>{ if(players[i].isAI) room.game.peeksDone.add(i); });

  broadcast(room);
  checkAllPeeked(room);

  setTimeout(()=>{
    if(room.game&&room.game.phase==='peek'){
      players.forEach((_,i)=>room.game.peeksDone.add(i));
      checkAllPeeked(room);
    }
  },15000);
}

function checkAllPeeked(room) {
  const g = room.game;
  if (!g || g.phase!=='peek') return;
  if (g.peeksDone.size < g.np) return;
  g.phase='draw';
  const cur=g.players[0];
  setSt(g, cur.isAI ? `תור של ${cur.name}...` : 'התורך! שלוף קלף.');
  broadcast(room);
  if (cur.isAI) setTimeout(()=>aiTurn(room),1500);
}

// ── Peek — FIX #1: pass peekerPi so only the peeker sees the card ──
function doPeek(room, targetPi, ci, peekerPi, cb) {
  const g = room.game;
  g.players[targetPi].peeking[ci] = true;
  g.players[targetPi].peeker[ci]  = peekerPi;
  broadcast(room);
  setTimeout(()=>{
    if(!room.game)return;
    g.players[targetPi].peeking[ci] = false;
    g.players[targetPi].peeker[ci]  = null;
    broadcast(room);
    if(cb)cb();
  },2000);
}

// ── Turn management ───────────────────────────────────────────
function endTurn(room) {
  const g = room.game;
  if(g.cambio){ g.turnsAfter++; if(g.turnsAfter>=g.np-1){endGame(room);return;} }
  advanceTurn(room);
}

function advanceTurn(room) {
  const g = room.game;
  g.cur=(g.cur+1)%g.np;
  g.drawn=null; g.spData={}; g.phase='draw';
  g.snapUsed=false; g.snapData={};

  const cur=g.players[g.cur];
  if(cur.cards.length===0&&!g.cambio){
    g.cambio=true; g.cambioWho=g.cur;
    addLog(g,`${cur.name} הגיע ל-0 קלפים — קמביו אוטומטי!`);
    setSt(g,`${cur.name} — 0 קלפים! קמביו אוטומטי!`,'cambio-flash');
    broadcast(room);
    setTimeout(()=>advanceTurn(room),1200);
    return;
  }

  setSt(g, cur.isAI ? `תור של ${cur.name}...` : 'התורך! שלוף קלף.');
  addLog(g,'');
  broadcast(room);
  if(cur.isAI) setTimeout(()=>aiTurn(room),1500);
}

// ── Snap ──────────────────────────────────────────────────────
function handleSnap(room, snapperSocketId, targetPi, targetCi) {
  const g = room.game;
  if(!g||g.over||g.snapUsed) return;
  if(g.phase==='peek') return;
  if(g.cambio&&g.cambioWho===targetPi) return;

  const snapperIdx = room.players.findIndex(p=>p.id===snapperSocketId);
  if(snapperIdx<0) return;
  if(g.cambio&&g.cambioWho===snapperIdx) return;

  const targetCard = g.players[targetPi].cards[targetCi];
  if(!targetCard) return;
  const topDisc = g.disc.length>0 ? g.disc[g.disc.length-1] : null;
  if(!topDisc) return;

  g.snapUsed=true;

  if(!topDisc.jk&&!targetCard.jk&&topDisc.v===targetCard.v){
    sendAnim(room, `c-${targetPi}-${targetCi}`, 'pile-disc', cardName(targetCard), isRed(targetCard));
    g.players[targetPi].cards.splice(targetCi,1);
    g.players[targetPi].peeking.splice(targetCi,1);
    g.players[targetPi].peeker.splice(targetCi,1);
    g.disc.push(targetCard);
    addLog(g,`${g.players[snapperIdx].name} הדביק! ${cardName(targetCard)} מ-${g.players[targetPi].name}`);

    if(snapperIdx===targetPi){
      setSt(g,`${g.players[snapperIdx].name} הדביק קלף שלו!`,'success');
      broadcast(room);
    } else {
      g.snapData={ snapperPi:snapperIdx, targetPi, wasAiTurn: g.cur!==snapperIdx };
      g.phase='snap-give';
      setSt(g,`הדבקה! ${g.players[snapperIdx].name} נותן קלף ל-${g.players[targetPi].name}.`,'snap');
      broadcast(room);
      if(g.players[snapperIdx].isAI) setTimeout(()=>aiGiveSnapCard(room),800);
    }
  } else {
    if(g.deck.length>0){
      const penalty=g.deck.pop();
      g.players[snapperIdx].cards.push(penalty);
      g.players[snapperIdx].peeking.push(true);
      g.players[snapperIdx].peeker.push(snapperIdx); // they see their own penalty
      addLog(g,`${g.players[snapperIdx].name} הדבקה שגויה! קיבל קלף עונש.`);
      setSt(g,`הדבקה שגויה! ${g.players[snapperIdx].name} קיבל קלף עונש.`,'snap');
      setTimeout(()=>{
        if(!room.game)return;
        const ni=g.players[snapperIdx].peeking.length-1;
        g.players[snapperIdx].peeking[ni]=false;
        g.players[snapperIdx].peeker[ni]=null;
        broadcast(room);
      },2000);
    }
    g.snapUsed=false;
    broadcast(room);
  }
}

function aiGiveSnapCard(room) {
  const g=room.game;
  if(!g||g.phase!=='snap-give')return;
  const sd=g.snapData;
  const ai=g.players[sd.snapperPi];
  let worst=0, worstPts=pts(ai.cards[0])||0;
  for(let k=1;k<ai.cards.length;k++) if(ai.cards[k]&&pts(ai.cards[k])>worstPts){worstPts=pts(ai.cards[k]);worst=k;}
  const givenCard=ai.cards[worst];
  sendAnim(room,`c-${sd.snapperPi}-${worst}`,`c-${sd.targetPi}-0`,cardName(givenCard),isRed(givenCard));
  ai.cards.splice(worst,1); ai.peeking.splice(worst,1); ai.peeker.splice(worst,1);
  g.players[sd.targetPi].cards.push(givenCard);
  g.players[sd.targetPi].peeking.push(false);
  g.players[sd.targetPi].peeker.push(null);
  addLog(g,`${ai.name} נתן ${cardName(givenCard)} ל-${g.players[sd.targetPi].name}`);
  setSt(g,'הדבקה הושלמה!','success');
  g.phase='draw'; g.snapData={};
  broadcast(room);
  if(sd.wasAiTurn && g.players[g.cur].isAI) setTimeout(()=>aiDraw(room),800);
}

function humanGiveSnapCard(room, socketId, cardIndex) {
  const g=room.game;
  if(!g||g.phase!=='snap-give')return;
  const sd=g.snapData;
  const snapperIdx=room.players.findIndex(p=>p.id===socketId);
  if(snapperIdx!==sd.snapperPi) return;
  const snapper=g.players[snapperIdx];
  if(cardIndex<0||cardIndex>=snapper.cards.length)return;
  const givenCard=snapper.cards[cardIndex];
  if(!givenCard)return;
  sendAnim(room,`c-${snapperIdx}-${cardIndex}`,`c-${sd.targetPi}-0`,cardName(givenCard),isRed(givenCard));
  snapper.cards.splice(cardIndex,1); snapper.peeking.splice(cardIndex,1); snapper.peeker.splice(cardIndex,1);
  g.players[sd.targetPi].cards.push(givenCard);
  g.players[sd.targetPi].peeking.push(false);
  g.players[sd.targetPi].peeker.push(null);
  addLog(g,`${snapper.name} נתן ${cardName(givenCard)} ל-${g.players[sd.targetPi].name}`);
  setSt(g,'הדבקה הושלמה!','success');
  g.phase='draw'; g.snapData={};
  broadcast(room);
  if(sd.wasAiTurn && g.players[g.cur].isAI) setTimeout(()=>aiDraw(room),800);
}

// ── AI turn ───────────────────────────────────────────────────
function aiTurn(room) {
  const g=room.game; if(!g||g.over)return;
  setTimeout(()=>{
    if(!room.game||g.over)return;
    if(!g.snapUsed&&g.disc.length>0){
      const topDisc=g.disc[g.disc.length-1];
      for(let oi=0;oi<g.np;oi++){
        if(oi===g.cur)continue;
        for(let ci=0;ci<g.players[oi].cards.length;ci++){
          const c=g.players[oi].cards[ci];
          if(c&&!c.jk&&!topDisc.jk&&c.v===topDisc.v&&Math.random()<0.5&&!(g.cambio&&g.cambioWho===oi)){
            g.snapUsed=true;
            const ai=g.players[g.cur];
            const targetCard=g.players[oi].cards[ci];
            sendAnim(room,`c-${oi}-${ci}`,'pile-disc',cardName(targetCard),isRed(targetCard));
            g.players[oi].cards.splice(ci,1); g.players[oi].peeking.splice(ci,1); g.players[oi].peeker.splice(ci,1);
            g.disc.push(targetCard);
            addLog(g,`${ai.name} הדביק! ${cardName(targetCard)} מ-${g.players[oi].name}`);
            setSt(g,`${ai.name} הדביק על ${g.players[oi].name}!`,'snap');
            broadcast(room);
            setTimeout(()=>{
              if(!room.game)return;
              let worst=0,worstPts=pts(ai.cards[0])||0;
              for(let k=1;k<ai.cards.length;k++) if(ai.cards[k]&&pts(ai.cards[k])>worstPts){worstPts=pts(ai.cards[k]);worst=k;}
              const givenCard=ai.cards[worst];
              sendAnim(room,`c-${g.cur}-${worst}`,`c-${oi}-0`,cardName(givenCard),isRed(givenCard));
              ai.cards.splice(worst,1); ai.peeking.splice(worst,1); ai.peeker.splice(worst,1);
              g.players[oi].cards.push(givenCard); g.players[oi].peeking.push(false); g.players[oi].peeker.push(null);
              addLog(g,`${ai.name} נתן ${cardName(givenCard)} ל-${g.players[oi].name}`);
              broadcast(room);
              setTimeout(()=>{
                if(!room.game)return;
                if(g.cambio&&g.cambioWho!==g.cur){g.turnsAfter++;if(g.turnsAfter>=g.np-1){endGame(room);return;}}
                advanceTurn(room);
              },700);
            },1000);
            return;
          }
        }
      }
    }
    aiDraw(room);
  },2000);
}

function aiDraw(room) {
  const g=room.game; if(!g||g.over)return;
  const ai=g.players[g.cur];
  let drawn;
  const useDiscard=g.disc.length>0&&pts(g.disc[g.disc.length-1])<=3;
  if(useDiscard) drawn=g.disc.pop(); else drawn=g.deck.pop();
  if(!drawn){afterAiAction(room);return;}

  setTimeout(()=>{
    if(!room.game)return;
    g.drawn=drawn; broadcast(room);

    if(isSp(drawn)){
      g.disc.push(drawn); g.drawn=null;
      sendAnim(room,'pile-deck','pile-disc',cardName(drawn),isRed(drawn));

      if(drawn.v==='7'||drawn.v==='8'){
        const ci=Math.floor(Math.random()*ai.cards.length);
        addLog(g,`${ai.name} הציץ בקלף ${ci+1} שלו`);
        setSt(g,`${ai.name} הציץ בקלף שלו.`);
        broadcast(room); afterAiAction(room);

      } else if(drawn.v==='9'||drawn.v==='10'){
        const hIdx=g.players.findIndex(p=>!p.isAI);
        if(hIdx>=0){
          const hci=Math.floor(Math.random()*g.players[hIdx].cards.length);
          addLog(g,`${ai.name} הציץ בקלף של ${g.players[hIdx].name}!`);
          setSt(g,`${ai.name} הציץ באחד הקלפים שלך...`,'warn');
        }
        broadcast(room); afterAiAction(room);

      } else if(drawn.v==='J'||drawn.v==='Q'){
        let worst=0,worstPts=pts(ai.cards[0])||0;
        for(let k=1;k<ai.cards.length;k++) if(ai.cards[k]&&pts(ai.cards[k])>worstPts){worstPts=pts(ai.cards[k]);worst=k;}
        let best2=0,best2Pts=999,best2Pi=-1;
        for(let oi=0;oi<g.np;oi++){
          if(oi===g.cur)continue;
          for(let k=0;k<g.players[oi].cards.length;k++){
            const c=g.players[oi].cards[k]; if(!c)continue;
            if(pts(c)<best2Pts&&!(g.cambio&&g.cambioWho===oi)){best2Pts=pts(c);best2=k;best2Pi=oi;}
          }
        }
        if(best2Pi!==-1){
          sendAnim(room,`c-${g.cur}-${worst}`,`c-${best2Pi}-${best2}`,'?',false);
          sendAnim(room,`c-${best2Pi}-${best2}`,`c-${g.cur}-${worst}`,'?',false);
          const tmp=ai.cards[worst]; ai.cards[worst]=g.players[best2Pi].cards[best2]; g.players[best2Pi].cards[best2]=tmp;
          addLog(g,`${ai.name} החליף עיוור`); setSt(g,`${ai.name} ביצע החלפה עיוורת!`,'warn');
        }
        broadcast(room); afterAiAction(room);

      } else if(drawn.v==='K'&&isRed(drawn)){
        g.disc.pop();
        let worst=0,worstPts=pts(ai.cards[0])||0;
        for(let k=1;k<ai.cards.length;k++) if(ai.cards[k]&&pts(ai.cards[k])>worstPts){worstPts=pts(ai.cards[k]);worst=k;}
        sendAnim(room,`c-${g.cur}-${worst}`,'pile-disc',cardName(ai.cards[worst]),isRed(ai.cards[worst]));
        g.disc.push(ai.cards[worst]); ai.cards[worst]=drawn;
        addLog(g,`${ai.name} שם King אדום`); setSt(g,`${ai.name} שם King אדום!`,'success');
        broadcast(room); afterAiAction(room);

      } else { // Black K
        let worst=0,worstPts=pts(ai.cards[0])||0;
        for(let k=1;k<ai.cards.length;k++) if(ai.cards[k]&&pts(ai.cards[k])>worstPts){worstPts=pts(ai.cards[k]);worst=k;}
        let bestOp=null,bestOpPts=999;
        for(let oi=0;oi<g.np;oi++){
          if(oi===g.cur||g.cambio&&g.cambioWho===oi)continue;
          for(let k=0;k<g.players[oi].cards.length;k++){
            const c=g.players[oi].cards[k]; if(!c)continue;
            if(pts(c)<bestOpPts){bestOpPts=pts(c);bestOp={pi:oi,ci:k};}
          }
        }
        setSt(g,`${ai.name} — King שחור!`,'warn');
        setTimeout(()=>{
          if(!room.game)return;
          if(bestOp){
            sendAnim(room,`c-${g.cur}-${worst}`,`c-${bestOp.pi}-${bestOp.ci}`,'?',false);
            sendAnim(room,`c-${bestOp.pi}-${bestOp.ci}`,`c-${g.cur}-${worst}`,'?',false);
            const tmp=ai.cards[worst]; ai.cards[worst]=g.players[bestOp.pi].cards[bestOp.ci]; g.players[bestOp.pi].cards[bestOp.ci]=tmp;
            addLog(g,`${ai.name} — King שחור: החליף`);
          }
          broadcast(room); afterAiAction(room);
        },800);
      }
      return;
    }

    // Regular card
    let best=0,bestPts=pts(ai.cards[0])||0;
    for(let i=1;i<ai.cards.length;i++) if(ai.cards[i]&&pts(ai.cards[i])>bestPts){bestPts=pts(ai.cards[i]);best=i;}
    if(pts(drawn)<bestPts){
      sendAnim(room,`c-${g.cur}-${best}`,'pile-disc',cardName(ai.cards[best]),isRed(ai.cards[best]));
      g.disc.push(ai.cards[best]); ai.cards[best]=drawn; g.drawn=null;
      addLog(g,`${ai.name} החליף קלף ${best+1}`); setSt(g,`${ai.name} החליף קלף.`);
    } else {
      sendAnim(room,'pile-deck','pile-disc',cardName(drawn),isRed(drawn));
      g.disc.push(drawn); g.drawn=null;
      addLog(g,`${ai.name} זרק ${cardName(drawn)}`); setSt(g,`${ai.name} זרק.`);
    }
    afterAiAction(room); broadcast(room);
  },600);
}

function afterAiAction(room) {
  const g=room.game; if(!g)return;
  const ai=g.players[g.cur];
  const total=ai.cards.reduce((s,c)=>s+pts(c),0);
  if(!g.cambio&&total<=5&&Math.random()<0.55){
    g.cambio=true; g.cambioWho=g.cur;
    addLog(g,`${ai.name} קרא קמביו!`);
    setSt(g,`${ai.name} קרא קמביו!`,'cambio-flash');
    broadcast(room);
    setTimeout(()=>advanceTurn(room),1000);
    return;
  }
  setTimeout(()=>{
    if(!room.game)return;
    if(g.cambio&&g.cambioWho!==g.cur){g.turnsAfter++;if(g.turnsAfter>=g.np-1){endGame(room);return;}}
    advanceTurn(room);
  },600);
  broadcast(room);
}

// ── End game ──────────────────────────────────────────────────
function endGame(room) {
  const g=room.game; if(!g)return;
  g.over=true;
  g.scores=g.players.map((p,i)=>({
    name:p.name, score:p.cards.reduce((s,c)=>s+pts(c),0),
    cambio:g.cambioWho===i, cards:p.cards
  }));
  setSt(g,'המשחק הסתיים!','success');
  broadcast(room);
}

// ── Special card phases for human ────────────────────────────
function useSpecial(room, socketId) {
  const g=room.game;
  const pi=room.players.findIndex(p=>p.id===socketId);
  if(pi!==g.cur||!g.drawn)return;
  const c=g.drawn;
  sendAnim(room,'pile-deck','pile-disc',cardName(c),isRed(c));
  g.disc.push(c); g.drawn=null;

  if(c.v==='7'||c.v==='8'){ g.phase='sp-peek-self'; setSt(g,'בחר קלף שלך להציץ.','action'); }
  else if(c.v==='9'||c.v==='10'){ g.phase='sp-peek-other'; setSt(g,'בחר קלף של יריב להציץ.','action'); }
  else if(c.v==='J'||c.v==='Q'){ g.phase='sp-swap-pick1'; g.spData={}; setSt(g,'בחר קלף ראשון להחלפה עיוורת.','warn'); }
  else if(c.v==='K'){
    if(isRed(c)){ addLog(g,'King אדום = −1'); setSt(g,'King אדום נזרק.','success'); endTurn(room); return; }
    else{ g.phase='bk-peek1'; g.spData={}; setSt(g,'King שחור: הצץ בקלף ראשון.','action'); }
  }
  broadcast(room);
}

function pickCard(room, socketId, targetPi, targetCi) {
  const g=room.game;
  const myPi=room.players.findIndex(p=>p.id===socketId);
  if(myPi!==g.cur)return;
  const ph=g.phase;

  if(ph==='sp-peek-self'){
    if(targetPi!==myPi)return;
    doPeek(room,myPi,targetCi,myPi,()=>{ addLog(g,`הצצת בקלף ${targetCi+1} שלך`); setSt(g,'הצצת בקלף שלך.','success'); endTurn(room); });
  } else if(ph==='sp-peek-other'){
    if(targetPi===myPi)return;
    // FIX #1: peeker is myPi, target card belongs to targetPi — only myPi will see it
    doPeek(room,targetPi,targetCi,myPi,()=>{ addLog(g,`הצצת בקלף ${targetCi+1} של ${g.players[targetPi].name}`); setSt(g,'הצצת בקלף של יריב.','success'); endTurn(room); });
  } else if(ph==='sp-swap-pick1'){
    g.spData={p1:targetPi,c1:targetCi}; g.phase='sp-swap-pick2';
    setSt(g,`בחרת קלף ${targetCi+1} של ${g.players[targetPi].name}. בחר קלף שני.`,'warn');
    broadcast(room);
  } else if(ph==='sp-swap-pick2'){
    const s=g.spData;
    if(targetPi===s.p1&&targetCi===s.c1)return;
    sendAnim(room,`c-${s.p1}-${s.c1}`,`c-${targetPi}-${targetCi}`,'?',false);
    sendAnim(room,`c-${targetPi}-${targetCi}`,`c-${s.p1}-${s.c1}`,'?',false);
    const tmp=g.players[s.p1].cards[s.c1]; g.players[s.p1].cards[s.c1]=g.players[targetPi].cards[targetCi]; g.players[targetPi].cards[targetCi]=tmp;
    addLog(g,`החלפת קלף ${s.c1+1} של ${g.players[s.p1].name} עם קלף ${targetCi+1} של ${g.players[targetPi].name}`);
    setSt(g,'החלפה עיוורת בוצעה!','success');
    endTurn(room);
  } else if(ph==='bk-peek1'){
    g.spData.p1=targetPi; g.spData.c1=targetCi;
    doPeek(room,targetPi,targetCi,myPi,()=>{ addLog(g,`הצצה 1: קלף ${targetCi+1} של ${g.players[targetPi].name}`); g.phase='bk-peek2'; setSt(g,'הצץ בקלף שני.','action'); broadcast(room); });
  } else if(ph==='bk-peek2'){
    const s=g.spData; if(targetPi===s.p1&&targetCi===s.c1)return;
    doPeek(room,targetPi,targetCi,myPi,()=>{ addLog(g,`הצצה 2: קלף ${targetCi+1} של ${g.players[targetPi].name}`); g.phase='bk-swap-pick1'; setSt(g,'בחר קלף ראשון להחלפה.','action'); broadcast(room); });
  } else if(ph==='bk-swap-pick1'){
    g.spData.sp1=targetPi; g.spData.sc1=targetCi; g.phase='bk-swap-pick2';
    setSt(g,`בחרת קלף ${targetCi+1} של ${g.players[targetPi].name}. בחר קלף שני.`,'warn');
    broadcast(room);
  } else if(ph==='bk-swap-pick2'){
    const s=g.spData; if(targetPi===s.sp1&&targetCi===s.sc1)return;
    sendAnim(room,`c-${s.sp1}-${s.sc1}`,`c-${targetPi}-${targetCi}`,'?',false);
    sendAnim(room,`c-${targetPi}-${targetCi}`,`c-${s.sp1}-${s.sc1}`,'?',false);
    const tmp=g.players[s.sp1].cards[s.sc1]; g.players[s.sp1].cards[s.sc1]=g.players[targetPi].cards[targetCi]; g.players[targetPi].cards[targetCi]=tmp;
    addLog(g,`King שחור: החלפת קלף ${s.sc1+1} של ${g.players[s.sp1].name} עם קלף ${targetCi+1} של ${g.players[targetPi].name}`);
    setSt(g,'King שחור בוצע!','success');
    endTurn(room);
  }
}

// ── Socket events ─────────────────────────────────────────────
io.on('connection', socket=>{

  socket.on('createRoom', ({name, aiCount}, cb)=>{
    let code; do { code=genCode(); } while(rooms[code]);
    rooms[code]={
      code, host:socket.id,
      players:[{id:socket.id, name, isAI:false}],
      started:false,
    };
    for(let i=1;i<=Math.min(aiCount||0,3);i++)
      rooms[code].players.push({id:null,name:`AI ${i}`,isAI:true});
    socket.join(code);
    cb({ok:true, code, players:rooms[code].players.map(p=>({name:p.name,isAI:p.isAI}))});
    io.to(code).emit('lobby',{players:rooms[code].players.map(p=>({name:p.name,isAI:p.isAI})),host:rooms[code].host,code});
  });

  socket.on('joinRoom', ({name, code}, cb)=>{
    const room=rooms[code];
    if(!room){cb({ok:false,err:'חדר לא נמצא'});return;}
    if(room.started){cb({ok:false,err:'המשחק כבר התחיל'});return;}
    const humanCount=room.players.filter(p=>!p.isAI).length;
    if(humanCount>=4){cb({ok:false,err:'החדר מלא'});return;}
    room.players.push({id:socket.id,name,isAI:false});
    socket.join(code);
    cb({ok:true, code, players:room.players.map(p=>({name:p.name,isAI:p.isAI}))});
    io.to(code).emit('lobby',{players:room.players.map(p=>({name:p.name,isAI:p.isAI})),host:room.host,code});
  });

  // FIX #4: createAndStart — solo mode, starts immediately without waiting
  socket.on('createAndStart', ({name, aiCount}, cb)=>{
    let code; do { code=genCode(); } while(rooms[code]);
    const room = {
      code, host:socket.id,
      players:[{id:socket.id, name, isAI:false}],
      started:true,
    };
    const n=Math.max(1,Math.min(aiCount||1,3));
    for(let i=1;i<=n;i++) room.players.push({id:null,name:`AI ${i}`,isAI:true});
    rooms[code]=room;
    socket.join(code);
    cb({ok:true, code});
    initGame(room);
  });

  socket.on('startGame', ()=>{
    const room=findRoomByPlayer(socket.id);
    if(!room||room.host!==socket.id||room.started)return;
    if(room.players.length<2){socket.emit('err','צריך לפחות 2 שחקנים');return;}
    room.started=true;
    initGame(room);
  });

  socket.on('peek', ({ci})=>{
    const room=findRoomByPlayer(socket.id);
    if(!room||!room.game)return;
    const g=room.game;
    if(g.phase!=='peek')return;
    const pi=room.players.findIndex(p=>p.id===socket.id);
    if(pi<0||g.peeksDone.has(pi))return;
    if(g.peeksLeft[pi]<=0)return;
    if(ci!==0&&ci!==1)return;
    if(g.players[pi].peeking[ci])return;
    g.peeksLeft[pi]--;
    doPeek(room,pi,ci,pi,()=>{  // peeker = card owner = pi
      if(g.peeksLeft[pi]<=0){
        g.peeksDone.add(pi);
        checkAllPeeked(room);
      }
    });
  });

  socket.on('drawDeck', ()=>{
    const room=findRoomByPlayer(socket.id);
    if(!room||!room.game)return;
    const g=room.game;
    const pi=room.players.findIndex(p=>p.id===socket.id);
    if(pi!==g.cur||g.phase!=='draw')return;
    if(g.deck.length===0)return;
    g.drawn=g.deck.pop(); g.phase='drawn';
    setSt(g,'שלפת קלף. בחר פעולה.');
    broadcast(room);
  });

  socket.on('drawDisc', ()=>{
    const room=findRoomByPlayer(socket.id);
    if(!room||!room.game)return;
    const g=room.game;
    const pi=room.players.findIndex(p=>p.id===socket.id);
    if(pi!==g.cur||g.phase!=='draw')return;
    if(g.disc.length===0)return;
    sendAnim(room,'pile-disc',`c-${pi}-0`,cardName(g.disc[g.disc.length-1]),isRed(g.disc[g.disc.length-1]));
    g.drawn=g.disc.pop(); g.phase='drawn';
    setSt(g,'שלפת מהזרוקים. בחר פעולה.');
    broadcast(room);
  });

  socket.on('replace', ({ci})=>{
    const room=findRoomByPlayer(socket.id);
    if(!room||!room.game)return;
    const g=room.game;
    const pi=room.players.findIndex(p=>p.id===socket.id);
    if(pi!==g.cur||g.phase!=='replace')return;
    if(ci<0||ci>=g.players[pi].cards.length)return;
    const old=g.players[pi].cards[ci];
    sendAnim(room,`c-${pi}-${ci}`,'pile-disc',cardName(old),isRed(old));
    g.disc.push(old); g.players[pi].cards[ci]=g.drawn; g.drawn=null;
    addLog(g,`${g.players[pi].name} החליף קלף ${ci+1}`);
    setSt(g,`${g.players[pi].name} החליף קלף.`);
    endTurn(room);
  });

  socket.on('doReplace', ()=>{
    const room=findRoomByPlayer(socket.id);
    if(!room||!room.game)return;
    const g=room.game;
    const pi=room.players.findIndex(p=>p.id===socket.id);
    if(pi!==g.cur||g.phase!=='drawn')return;
    g.phase='replace'; setSt(g,'בחר קלף שלך להחליף.','action'); broadcast(room);
  });

  socket.on('discard', ()=>{
    const room=findRoomByPlayer(socket.id);
    if(!room||!room.game)return;
    const g=room.game;
    const pi=room.players.findIndex(p=>p.id===socket.id);
    if(pi!==g.cur||g.phase!=='drawn')return;
    sendAnim(room,'pile-deck','pile-disc',cardName(g.drawn),isRed(g.drawn));
    g.disc.push(g.drawn); g.drawn=null;
    addLog(g,`${g.players[pi].name} זרק`); setSt(g,`${g.players[pi].name} זרק.`);
    endTurn(room);
  });

  socket.on('useSpecial', ()=>{ const room=findRoomByPlayer(socket.id); if(room)useSpecial(room,socket.id); });
  socket.on('pickCard', ({targetPi,targetCi})=>{ const room=findRoomByPlayer(socket.id); if(room)pickCard(room,socket.id,targetPi,targetCi); });

  socket.on('cambio', ()=>{
    const room=findRoomByPlayer(socket.id);
    if(!room||!room.game)return;
    const g=room.game;
    const pi=room.players.findIndex(p=>p.id===socket.id);
    if(pi!==g.cur||g.phase!=='draw'||g.cambio)return;
    g.cambio=true; g.cambioWho=pi;
    addLog(g,`${g.players[pi].name} קרא קמביו!`);
    setSt(g,`${g.players[pi].name} קרא קמביו! לכולם עוד תור אחד.`,'cambio-flash');
    broadcast(room); advanceTurn(room);
  });

  socket.on('snap', ({targetPi,targetCi})=>{ const room=findRoomByPlayer(socket.id); if(room)handleSnap(room,socket.id,targetPi,targetCi); });
  socket.on('giveCard', ({ci})=>{ const room=findRoomByPlayer(socket.id); if(room)humanGiveSnapCard(room,socket.id,ci); });

  // Rejoin after mobile disconnect/reconnect
  socket.on('rejoin', ({name, code}, cb)=>{
    const room=rooms[code];
    if(!room){if(cb)cb({ok:false});return;}
    const player=room.players.find(p=>p.name===name&&!p.isAI);
    if(!player){if(cb)cb({ok:false});return;}
    const wasHost=room.host===player.id;
    player.id=socket.id;
    if(wasHost) room.host=socket.id;
    socket.join(code);
    if(!room.started){
      io.to(code).emit('lobby',{players:room.players.map(p=>({name:p.name,isAI:p.isAI})),host:room.host,code});
    } else if(room.game){
      io.to(socket.id).emit('state', stateFor(room, socket.id));
    }
    if(cb)cb({ok:true});
  });

  socket.on('disconnect', ()=>{
    const room=findRoomByPlayer(socket.id);
    if(!room)return;
    if(!room.started){
      room.players=room.players.filter(p=>p.id!==socket.id);
      if(room.players.filter(p=>!p.isAI).length===0){ delete rooms[room.code]; return; }
      io.to(room.code).emit('lobby',{players:room.players.map(p=>({name:p.name,isAI:p.isAI})),host:room.host,code:room.code});
    } else {
      io.to(room.code).emit('playerLeft',{name:room.players.find(p=>p.id===socket.id)?.name});
    }
  });
});

server.listen(PORT,()=>console.log(`Cambio server on port ${PORT}`));
