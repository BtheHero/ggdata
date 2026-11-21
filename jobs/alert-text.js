// The words of alert emails and notifications (jobs/alerts.js), in the language the person uses the site in (u.lang,
// saved with their account by the site). Game names, prices and store names are filled in; everything else is here.
const LOCALE = { en: "en-US", es: "es-ES", pt: "pt-BR", fr: "fr-FR", de: "de-DE", it: "it-IT", pl: "pl-PL", tr: "tr-TR", ru: "ru-RU",
  ja: "ja-JP", ko: "ko-KR", zh: "zh-CN" };

const T = {
  en: {
    lead1: "A game you're watching has a new price:", leadN: "Games you're watching have new prices:",
    wishlist: "See your wishlist", unsub: "Unsubscribe from alert emails",
    footer: "Prices are your region's store's (as picked on the site) and can change. You get these because you turned on alerts on GameDealTrack.",
    yourAlert: a => `Your alert: ${a}`, store: r => `${r} store`, ends: d => `Sale ends ${d}`, onSale: "On sale", pctOff: n => `${n}% off`,
    subjN: n => `${n} games you're watching have new prices`, subjTarget: (g, p, a) => `${g} is now ${p} (your alert: ${a})`, subjSale: (g, p) => `${g} is on sale: ${p}`,
    pushTarget: g => `Your price alert: ${g}`, pushSale: g => `On sale: ${g}`, was: p => `(was ${p})`
  },
  es: {
    lead1: "Un juego que sigues tiene un precio nuevo:", leadN: "Juegos que sigues tienen precios nuevos:",
    wishlist: "Ver tu lista de deseos", unsub: "Darse de baja de los correos de alertas",
    footer: "Los precios son los de la tienda de tu región (la elegida en el sitio) y pueden cambiar. Recibes estos correos porque activaste las alertas en GameDealTrack.",
    yourAlert: a => `Tu alerta: ${a}`, store: r => `tienda de ${r}`, ends: d => `La oferta termina el ${d}`, onSale: "En oferta", pctOff: n => `${n} % de descuento`,
    subjN: n => `${n} juegos que sigues tienen precios nuevos`, subjTarget: (g, p, a) => `${g} ahora cuesta ${p} (tu alerta: ${a})`, subjSale: (g, p) => `${g} está en oferta: ${p}`,
    pushTarget: g => `Tu alerta de precio: ${g}`, pushSale: g => `En oferta: ${g}`, was: p => `(antes ${p})`
  },
  pt: {
    lead1: "Um jogo que você acompanha tem um novo preço:", leadN: "Jogos que você acompanha têm novos preços:",
    wishlist: "Ver sua lista de desejos", unsub: "Cancelar os e-mails de alerta",
    footer: "Os preços são os da loja da sua região (a escolhida no site) e podem mudar. Você recebe estes e-mails porque ativou os alertas no GameDealTrack.",
    yourAlert: a => `Seu alerta: ${a}`, store: r => `loja de ${r}`, ends: d => `A promoção termina em ${d}`, onSale: "Em promoção", pctOff: n => `${n}% de desconto`,
    subjN: n => `${n} jogos que você acompanha têm novos preços`, subjTarget: (g, p, a) => `${g} agora custa ${p} (seu alerta: ${a})`, subjSale: (g, p) => `${g} está em promoção: ${p}`,
    pushTarget: g => `Seu alerta de preço: ${g}`, pushSale: g => `Em promoção: ${g}`, was: p => `(antes ${p})`
  },
  fr: {
    lead1: "Un jeu que vous suivez a un nouveau prix :", leadN: "Des jeux que vous suivez ont de nouveaux prix :",
    wishlist: "Voir votre liste de souhaits", unsub: "Se désinscrire des e-mails d'alerte",
    footer: "Les prix sont ceux de la boutique de votre région (choisie sur le site) et peuvent changer. Vous recevez ces e-mails parce que vous avez activé les alertes sur GameDealTrack.",
    yourAlert: a => `Votre alerte : ${a}`, store: r => `boutique ${r}`, ends: d => `Fin de la promo le ${d}`, onSale: "En promo", pctOff: n => `${n} % de réduction`,
    subjN: n => `${n} jeux que vous suivez ont de nouveaux prix`, subjTarget: (g, p, a) => `${g} est maintenant à ${p} (votre alerte : ${a})`, subjSale: (g, p) => `${g} est en promo : ${p}`,
    pushTarget: g => `Votre alerte de prix : ${g}`, pushSale: g => `En promo : ${g}`, was: p => `(au lieu de ${p})`
  },
  de: {
    lead1: "Ein Spiel, das du beobachtest, hat einen neuen Preis:", leadN: "Spiele, die du beobachtest, haben neue Preise:",
    wishlist: "Zu deiner Wunschliste", unsub: "Benachrichtigungs-E-Mails abbestellen",
    footer: "Die Preise sind die des Stores deiner Region (wie auf der Website gewählt) und können sich ändern. Du bekommst diese E-Mails, weil du auf GameDealTrack Benachrichtigungen eingeschaltet hast.",
    yourAlert: a => `Dein Preisalarm: ${a}`, store: r => `Store ${r}`, ends: d => `Angebot endet am ${d}`, onSale: "Im Angebot", pctOff: n => `${n} % Rabatt`,
    subjN: n => `${n} Spiele, die du beobachtest, haben neue Preise`, subjTarget: (g, p, a) => `${g} kostet jetzt ${p} (dein Preisalarm: ${a})`, subjSale: (g, p) => `${g} ist im Angebot: ${p}`,
    pushTarget: g => `Dein Preisalarm: ${g}`, pushSale: g => `Im Angebot: ${g}`, was: p => `(vorher ${p})`
  },
  it: {
    lead1: "Un gioco che segui ha un nuovo prezzo:", leadN: "Alcuni giochi che segui hanno nuovi prezzi:",
    wishlist: "Vedi la tua lista dei desideri", unsub: "Annulla l'iscrizione alle email di avviso",
    footer: "I prezzi sono quelli dello store della tua regione (scelta sul sito) e possono cambiare. Ricevi queste email perché hai attivato gli avvisi su GameDealTrack.",
    yourAlert: a => `Il tuo avviso: ${a}`, store: r => `store ${r}`, ends: d => `L'offerta termina il ${d}`, onSale: "In offerta", pctOff: n => `${n}% di sconto`,
    subjN: n => `${n} giochi che segui hanno nuovi prezzi`, subjTarget: (g, p, a) => `${g} ora costa ${p} (il tuo avviso: ${a})`, subjSale: (g, p) => `${g} è in offerta: ${p}`,
    pushTarget: g => `Il tuo avviso di prezzo: ${g}`, pushSale: g => `In offerta: ${g}`, was: p => `(prima ${p})`
  },
  pl: {
    lead1: "Gra, którą obserwujesz, ma nową cenę:", leadN: "Gry, które obserwujesz, mają nowe ceny:",
    wishlist: "Zobacz swoją listę życzeń", unsub: "Wypisz się z e-maili z powiadomieniami",
    footer: "Ceny pochodzą ze sklepu Twojego regionu (wybranego na stronie) i mogą się zmienić. Dostajesz te wiadomości, bo włączono powiadomienia w GameDealTrack.",
    yourAlert: a => `Twój alert: ${a}`, store: r => `sklep: ${r}`, ends: d => `Promocja kończy się ${d}`, onSale: "W promocji", pctOff: n => `${n}% taniej`,
    subjN: n => `Obserwowane gry (${n}) mają nowe ceny`, subjTarget: (g, p, a) => `${g} kosztuje teraz ${p} (Twój alert: ${a})`, subjSale: (g, p) => `${g} w promocji: ${p}`,
    pushTarget: g => `Twój alert cenowy: ${g}`, pushSale: g => `W promocji: ${g}`, was: p => `(wcześniej ${p})`
  },
  tr: {
    lead1: "Takip ettiğin bir oyunun yeni bir fiyatı var:", leadN: "Takip ettiğin oyunların yeni fiyatları var:",
    wishlist: "İstek listeni gör", unsub: "Uyarı e-postalarından çık",
    footer: "Fiyatlar bölgenin mağazasına aittir (sitede seçilen) ve değişebilir. Bu e-postaları GameDealTrack'te uyarıları açtığın için alıyorsun.",
    yourAlert: a => `Uyarın: ${a}`, store: r => `${r} mağazası`, ends: d => `İndirim ${d} tarihinde bitiyor`, onSale: "İndirimde", pctOff: n => `%${n} indirim`,
    subjN: n => `Takip ettiğin ${n} oyunun yeni fiyatı var`, subjTarget: (g, p, a) => `${g} artık ${p} (uyarın: ${a})`, subjSale: (g, p) => `${g} indirimde: ${p}`,
    pushTarget: g => `Fiyat uyarın: ${g}`, pushSale: g => `İndirimde: ${g}`, was: p => `(önceden ${p})`
  },
  ru: {
    lead1: "У игры, за которой вы следите, новая цена:", leadN: "У игр, за которыми вы следите, новые цены:",
    wishlist: "Открыть список желаемого", unsub: "Отписаться от писем с оповещениями",
    footer: "Цены указаны по магазину вашего региона (выбранного на сайте) и могут меняться. Вы получаете эти письма, потому что включили оповещения на GameDealTrack.",
    yourAlert: a => `Ваше оповещение: ${a}`, store: r => `магазин: ${r}`, ends: d => `Скидка до ${d}`, onSale: "Со скидкой", pctOff: n => `скидка ${n}%`,
    subjN: n => `Новые цены на игры, за которыми вы следите: ${n}`, subjTarget: (g, p, a) => `${g} теперь стоит ${p} (ваше оповещение: ${a})`, subjSale: (g, p) => `${g} со скидкой: ${p}`,
    pushTarget: g => `Ваше оповещение о цене: ${g}`, pushSale: g => `Со скидкой: ${g}`, was: p => `(было ${p})`
  },
  ja: {
    lead1: "ウォッチ中のゲームの価格が変わりました：", leadN: "ウォッチ中のゲームの価格が変わりました：",
    wishlist: "ウィッシュリストを見る", unsub: "アラートメールの配信を停止",
    footer: "価格はお住まいの地域（サイトで選択したもの）のストアのもので、変わる場合があります。GameDealTrackでアラートをオンにしたため、このメールをお送りしています。",
    yourAlert: a => `あなたのアラート：${a}`, store: r => `${r}のストア`, ends: d => `セールは${d}まで`, onSale: "セール中", pctOff: n => `${n}%オフ`,
    subjN: n => `ウォッチ中の${n}本のゲームの価格が変わりました`, subjTarget: (g, p, a) => `${g}が${p}になりました（あなたのアラート：${a}）`, subjSale: (g, p) => `${g}がセール中：${p}`,
    pushTarget: g => `価格アラート：${g}`, pushSale: g => `セール中：${g}`, was: p => `（通常${p}）`
  },
  ko: {
    lead1: "관심 있는 게임의 가격이 바뀌었습니다:", leadN: "관심 있는 게임들의 가격이 바뀌었습니다:",
    wishlist: "위시리스트 보기", unsub: "알림 이메일 수신 거부",
    footer: "가격은 사이트에서 선택한 지역 스토어 기준이며 바뀔 수 있습니다. GameDealTrack에서 알림을 켜셨기 때문에 이 이메일을 받고 계십니다.",
    yourAlert: a => `내 알림: ${a}`, store: r => `${r} 스토어`, ends: d => `할인 종료: ${d}`, onSale: "할인 중", pctOff: n => `${n}% 할인`,
    subjN: n => `관심 있는 게임 ${n}개의 가격이 바뀌었습니다`, subjTarget: (g, p, a) => `${g} 현재 ${p} (내 알림: ${a})`, subjSale: (g, p) => `${g} 할인 중: ${p}`,
    pushTarget: g => `가격 알림: ${g}`, pushSale: g => `할인 중: ${g}`, was: p => `(정가 ${p})`
  },
  zh: {
    lead1: "你关注的一款游戏有了新价格：", leadN: "你关注的游戏有了新价格：",
    wishlist: "查看你的愿望单", unsub: "退订提醒邮件",
    footer: "价格为你所在地区（在网站上选择）商店的价格，可能会变动。你收到这些邮件是因为你在 GameDealTrack 上开启了提醒。",
    yourAlert: a => `你的提醒：${a}`, store: r => `${r}商店`, ends: d => `优惠截至 ${d}`, onSale: "特价中", pctOff: n => `${n}% 折扣`,
    subjN: n => `你关注的 ${n} 款游戏有了新价格`, subjTarget: (g, p, a) => `${g} 现价 ${p}（你的提醒：${a}）`, subjSale: (g, p) => `${g} 特价：${p}`,
    pushTarget: g => `价格提醒：${g}`, pushSale: g => `特价：${g}`, was: p => `（原价 ${p}）`
  }
};

// The words, money, dates and region names in a language ("en" for anything else)
function alertText(lang) {
  const l = T[lang] ? lang : "en", loc = LOCALE[l];
  let regions = null;
  try { regions = new Intl.DisplayNames([loc], { type: "region" }); } catch (e) {}
  return Object.assign({}, T[l], {
    lang: l, locale: loc,
    money: (v, c) => { try { return new Intl.NumberFormat(loc, { style: "currency", currency: c || "USD" }).format(v); } catch (e) { return v + " " + (c || ""); } },
    date: d => new Date(d).toLocaleDateString(loc, { month: "short", day: "numeric", timeZone: "UTC" }),
    region: code => code === "US" && l === "en" ? "US" : (regions && regions.of(code)) || code,
    // a page on the site in the language: "/deals" -> "/es/deals"
    path: p => l === "en" ? p : "/" + l + p
  });
}

module.exports = { alertText, ALERT_LANGS: Object.keys(T) };
