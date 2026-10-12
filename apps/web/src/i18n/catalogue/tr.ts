/**
 * Arayüzün Türkçesi.
 *
 * `Catalogue` türü İngilizce katalogdan türetilir: burada eksik ya da fazla bir
 * anahtar derleme hatasıdır (D-41). Aynı `{yer tutucu}` adlarını kullanmak ise
 * derleyicinin göremediği tek şeydir; `i18n.test.ts` onu denetler.
 *
 * Üslup İngilizcedekiyle aynı: kısa, düz fiiller, cümle düzeni, özür dilemeyen
 * hata iletileri. Türkçede çoğul eki sayıdan sonra gelmez ("4 yanıt"), bu yüzden
 * çoğul iletiler yalnızca `other` biçimini taşır. Ekler yer tutucudan sonra
 * gelmesin diye iletiler, değişkenin yanında ek gerektirmeyecek biçimde yazıldı.
 * Kullanıcıların birbirine yazdıkları asla çevrilmez.
 */
import type { Catalogue } from '../types';

export const tr = {
  // ── Ortak ───────────────────────────────────────────────────────────────
  'common.close': 'Kapat',
  'common.cancel': 'Vazgeç',
  'common.create': 'Oluştur',
  'common.copy': 'Kopyala',
  'common.copied': 'Kopyalandı',
  'common.retry': 'Yeniden dene',
  'common.undo': 'Geri al',
  'common.loading': 'Yükleniyor',

  // ── Uygulama ────────────────────────────────────────────────────────────
  'app.skip': 'Konuşmaya atla',
  'app.placeholder.title': 'Bu ekran henüz yapılmadı',
  'app.placeholder.body':
    'Çevresindeki çerçeve son hâlinde; ekran kendi backend’iyle birlikte gelecek.',
  'app.notFound.title': 'Burada bir şey yok',
  'app.notFound.body': 'Bu adres Purlay içinde hiçbir yere çıkmıyor.',
  'app.notFound.home': 'Kanallarına git',

  // ── Giriş ───────────────────────────────────────────────────────────────
  'signIn.title': "Purlay'e giriş yap",
  'signIn.lede': 'Bir soru, biri kapatana kadar açık kalan ekip sohbeti.',
  'signIn.github': 'GitHub ile devam et',
  'signIn.failed': 'Giriş tamamlanamadı. Yeniden dene.',
  'signIn.ended': 'Oturumun sona erdi. Devam etmek için yeniden giriş yap.',
  'signIn.scope': "Purlay GitHub'dan yalnızca adını, kullanıcı adını ve e-postanı ister.",

  // ── Çalışma alanı ve kenar çubuğu ───────────────────────────────────────
  'sidebar.label': 'Çalışma alanı',
  'sidebar.switch': 'Çalışma alanını değiştir',
  'sidebar.questions': 'Açık sorular',
  'sidebar.channels': 'Kanallar',
  'sidebar.people': 'Kişiler',
  'sidebar.newChannel': 'Yeni kanal',
  'sidebar.jump': 'Şuraya geç…',
  'sidebar.private': 'özel',
  'sidebar.you': 'sen',
  'sidebar.mentions': {
    other: '{count} okunmamış bahsetme',
  },
  // ── Sidebar chrome ──────────────────────────────────────────────────────
  'sidebar.workspaces': 'Çalışma alanları',
  'sidebar.signedInAs': '{name} olarak giriş yapıldı',
  'sidebar.browse': 'Kanallara göz at',
  'sidebar.questions.many': '99+',
  'sidebar.unread': 'okunmamış',
  'sidebar.dm.failed': 'Konuşma açılamadı.',
  'sidebar.people.empty': 'Burada henüz başka kimse yok.',

  // ── Dar pencere (UX §2): kenar çubuğu üst katman olur ────────────────────
  'nav.open': 'Gezinmeyi aç',
  'nav.description': 'Kanallar, kişiler ve açık sorular',

  'browse.title': 'Kanallara göz at',
  'browse.description': 'Henüz katılmadığın herkese açık kanallar.',
  'browse.join': 'Katıl',
  'browse.joinLabel': '{name} kanalına katıl',
  'browse.joinFailed': 'Kanala katılamadın.',
  'browse.loading': 'Kanallar yükleniyor',
  'browse.empty.title': 'Katılacak kanal yok',
  'browse.empty.body': 'Var olan tüm herkese açık kanallardasın.',
  'browse.error.title': 'Kanallar yüklenemedi',
  'browse.error.body': 'Sunucu yanıt vermedi. Yeniden dene.',

  'workspace.none.title': 'Henüz bir çalışma alanında değilsin',
  'workspace.none.body':
    'Bir sahibinden seni eklemesini iste ya da zaten bir çalışma alanına ait hesapla giriş yap.',
  'workspace.create.title': 'Çalışma alanı oluştur',
  'workspace.create.body':
    'Çalışma alanı, bir ekibin konuştuğu yerdir. Diğerlerini sonra davet edebilirsin.',
  'workspace.create.name': 'Ad',
  'workspace.create.slug': 'Adres',
  'workspace.create.slugHint':
    'Küçük harf, rakam ve tire. Web adresinin parçasıdır ve sonradan değişmez.',
  'workspace.create.submit': 'Çalışma alanı oluştur',
  'workspace.create.taken': 'Bu adres alınmış. Başka bir tane seç.',
  'workspace.create.invalid': 'Küçük harf, rakam ve tire kullan; harf ya da rakamla başla.',
  'workspace.create.failed': 'Çalışma alanı oluşturulamadı.',
  'state.session.error.title': "Purlay'e ulaşılamadı",
  'state.session.error.body': 'Sunucu yanıt vermedi. Oturumun açık; tekrar dene.',
  'state.channel.missing.title': 'Bu kanal burada değil',
  'state.channel.missing.body': 'Ya yok ya da göremiyorsun.',
  'state.workspace.empty.title': 'Bir kanal seç',
  'state.workspace.empty.body': 'Listeden birini seç ya da ilkini oluştur.',

  // ── Yeni kanal ──────────────────────────────────────────────────────────
  'newChannel.title': 'Yeni kanal',
  'newChannel.description': 'Çalışma alanındaki herkes herkese açık bir kanalı bulup katılabilir.',
  'newChannel.name': 'Ad',
  'newChannel.nameHint': 'Küçük harf, rakam ve tire. En çok 64 karakter.',
  'newChannel.topic': 'Konu',
  'newChannel.topicHint': 'İsteğe bağlı. Kanalın ne için olduğunu anlatan tek satır.',
  'newChannel.private': 'Özel',
  'newChannel.privateHint': 'Yalnızca içindekiler görür. Bir üye başkalarını ekler.',
  'people.add': 'Kişi ekle',
  'people.title': '{name} kanalına kişi ekle',
  'people.description': 'Kanalı ve içinde konuşulanları hemen görürler.',
  'people.filter': 'Kişi ara',
  'people.addOne': 'Ekle',
  'people.added': 'Eklendi',
  'people.loading': 'Kişiler yükleniyor…',
  'people.failed': 'Bu çalışma alanının kişileri yüklenemedi.',
  'people.none': 'Bu çalışma alanında henüz başka kimse yok.',
  'people.noMatch': 'Bu isimde kimse yok.',
  'people.addFailed': '{name} eklenmedi.',
  'newChannel.create': 'Kanalı oluştur',
  'newChannel.taken': 'Bu adda bir kanal zaten var. Başka bir ad seç.',
  'newChannel.invalid': 'Küçük harf, rakam ve tire kullan; harf ya da rakamla başla.',
  'newChannel.failed': 'Kanal oluşturulamadı.',

  // ── Kanal başlığı ───────────────────────────────────────────────────────
  'header.views': 'Kanal görünümleri',
  'header.feed': 'Akış',
  'header.questions': 'Açık sorular',
  'header.noTopic': 'Henüz konu yok',

  // ── Mesajlar ────────────────────────────────────────────────────────────
  'message.react': 'Tepki ver',
  'message.reacted': 'Tepki verildi',
  'message.reply': 'Yanıtla',
  'message.edited': 'düzenlendi',
  'message.deleted': 'Bu mesaj silindi.',
  'message.edit': 'Düzenle',
  'message.delete': 'Sil',
  'message.editLabel': 'Mesajını düzenle',
  'message.editSave': 'Kaydet',
  'message.editHint': 'Kaydetmek için Enter · vazgeçmek için Esc',
  'message.editFailed': 'Düzenlemen kaydedilmedi.',
  'message.deleteTitle': 'Bu mesaj silinsin mi?',
  'message.deleteBody': 'Yerine silindiğini söyleyen bir not gelir. Yanıtları kalır.',
  'message.deleteFailed': 'Mesaj silinmedi.',
  'message.more': 'Daha fazla',
  'message.mention': 'Senden bahsedildi',
  'message.newMarker': 'Yeni',
  'message.newMessages': {
    other: '{count} yeni mesaj',
  },
  'message.jumpToNew': 'Yeni mesajlara git',
  'message.today': 'Bugün',
  'message.yesterday': 'Dün',
  'message.reactions': {
    other: '{count} tepki',
  },
  'message.addReaction': 'Tepki ekle',
  'message.removeReaction': 'Tepkini kaldır',
  'message.code.copy': 'Kodu kopyala',
  'message.code.expand': 'Tüm {count} satırı göster',
  'message.code.collapse': 'Daha az satır göster',
  'message.code.lines': {
    other: '{count} satır',
  },

  // ── Akış (D-98) ─────────────────────────────────────────────────────────
  'feed.label': '{channel} kanalındaki mesajlar',
  'feed.row': '{name}, {when}',
  'feed.dmTitle': '{name} ile doğrudan mesaj',
  'feed.selfDm': '{name} (sen)',
  'feed.olderLoading': 'Eski mesajlar yükleniyor',
  'feed.olderError': 'Eski mesajlar yüklenemedi',
  'feed.olderRetry': 'Tekrar dene',
  'feed.start': 'Kanalın başı burası',
  'channel.join.notice': '#{name} kanalını üye olmadan okuyorsun.',
  'channel.join.action': 'Kanala katıl',
  'channel.join.failed': 'Kanala katılınamadı.',
  'message.reactWith': '{emoji} ile tepki ver',
  'message.quickReactions': 'Hızlı tepkiler',
  'message.reactionOf': {
    other: '{emoji}, {count} tepki',
  },
  'message.code.language': 'Dil: {language}',
  'message.code.plain': 'metin',
  'message.link.external': 'Yeni sekmede açılır',
  'message.table': 'Tablo',
  'message.task.done': 'Tamamlandı',
  'message.task.open': 'Tamamlanmadı',
  'message.reactionFailed': 'Tepki kaydedilemedi.',
  'reaction.thumbsUp': 'Beğen',
  'reaction.heart': 'Kalp',
  'reaction.celebrate': 'Kutla',
  'reaction.eyes': 'Bakıyorum',
  'reaction.rocket': 'Yayına al',
  'reaction.done': 'Tamam',
  'reaction.smile': 'Gülümse',

  // ── Teslimat (UX §3.1) ──────────────────────────────────────────────────
  'delivery.sending': 'Gönderiliyor',
  'delivery.sent': 'Gönderildi',
  'delivery.failed': 'Gönderilemedi',
  'delivery.retry': 'Yeniden dene',
  'delivery.delete': 'Sil',
  'delivery.announce.sent': 'Mesaj gönderildi',
  'delivery.announce.failed': 'Mesaj gönderilemedi',

  // ── Thread (UX §4) ──────────────────────────────────────────────────────
  'thread.label': '{name} tarafından başlatılan thread: {status}',
  'thread.status.open': 'açık',
  'thread.status.resolved': 'çözüldü',
  'thread.replies': {
    other: '{count} yanıt',
  },
  'thread.open': 'Açık · {replies} · son: {when}',
  'thread.resolved': 'Çözen: {name} · {replies}',
  'thread.show': "Thread'i göster",
  'thread.collapse': 'Daralt',
  'thread.resolve': 'Çöz',
  'thread.reopen': 'Yeniden aç',
  'thread.replyPlaceholder': "Thread'e yanıt yaz…",
  'thread.replyLabel': "Thread'e yanıt",
  'thread.loading': 'Yanıtlar yükleniyor…',
  'thread.error': 'Yanıtlar yüklenemedi',
  'thread.announce.resolved': 'Thread çözüldü',
  'thread.announce.reopened': 'Thread yeniden açıldı',

  // ── Threads, in place (D-98) ────────────────────────────────────────────
  'thread.reply': 'Yanıtla',
  'thread.loadMore': 'Daha fazla yanıt yükle',
  'thread.none': 'Henüz yanıt yok',
  'thread.composerName': '{channel} kanalındaki bir thread',
  'thread.resolveFailed': 'Yalnızca en az bir yanıtı olan thread çözülebilir.',
  'thread.actionFailed': 'Thread değişmedi.',

  // ── Mesaj kutusu (UX §5) ────────────────────────────────────────────────
  'composer.bold': 'Kalın',
  'composer.codeBlock': 'Kod bloğu',
  'composer.mention': 'Birini an',
  'composer.label': '{channel} kanalına mesaj',
  'composer.placeholder': '{channel} kanalına yaz. Enter gönderir, Shift+Enter yeni satır ekler.',
  'composer.send': 'Gönder',
  'composer.pasted': 'Yapıştırılan metin kod bloğuna dönüştü',
  'composer.tooLong': {
    other: 'Sınırı {count} karakter aşıyor.',
  },
  'composer.hint.send': 'gönderir',
  'composer.hint.newline': 'yeni satır',

  // ── Mesaj kutusu: göndermeden önce denetlenenler (D-99 §3) ──────────────
  'composer.hint.code': 'kod bloğu',
  'composer.remaining': {
    other: '{count} karakter kaldı',
  },
  'composer.invalid': 'Bu mesajda Purlay’in gönderemediği bir karakter var. Kaldırıp tekrar dene.',
  'composer.broadcast':
    '{mention} kullanılamaz: Purlay herkese bildirim göndermez. Kimi kastettiysen adıyla an.',

  // ── Bağlantı (UX §8) ────────────────────────────────────────────────────
  'connection.reconnecting': 'Yeniden bağlanılıyor… geri döndüğünde mesajlar gönderilecek',
  'connection.ended': 'Oturumun sona erdi',

  // ── Durumlar (UX §8) ────────────────────────────────────────────────────
  'state.feed.empty.title': 'Henüz mesaj yok',
  'state.feed.empty.body':
    'Bu kanal yeni. İlk mesajda ne için olduğunu yaz; mesaj kutusu aşağıda hazır.',
  'state.feed.loading': 'Mesajlar yükleniyor',
  'state.feed.error.title': 'Mesajlar yüklenemedi',
  'state.feed.error.body': 'Sunucu yanıt vermedi. Taslağın güvende.',
  'state.questions.empty.title': 'Her thread çözüldü',
  'state.questions.empty.body': 'Bir thread, yanıt aldığı ve çözülmediği an burada görünür.',
  'state.questions.loading': 'Açık sorular yükleniyor',
  'state.questions.error.title': 'Açık sorular yüklenemedi',
  'state.questions.error.body': 'Sunucu yanıt vermedi. Yeniden dene.',
  'state.channels.loading': 'Kanallar yükleniyor',
  'state.channels.error.title': 'Kanallar yüklenemedi',
  'state.channels.error.body': 'Sunucu yanıt vermedi. Yeniden dene.',
  'state.channels.empty.title': 'Henüz kanal yok',
  'state.channels.empty.body': 'İlkini oluştur; yalnızca bir ad yeter.',

  // ── A new build (#334) ──────────────────────────────────────────────────
  'update.available': 'Purlay güncellendi. Yeni sürüm için yenile; taslakların korunur.',
  'update.reload': 'Yenile',

  // ── Search (D-105) ─────────────────────────────────────────────────────
  'search.title': 'Ara',
  'search.label': 'Mesajlarda ara',
  'search.hint': 'Görebildiğin tüm kanallarda aramak için Enter’a bas.',
  'search.searching': 'Aranıyor…',
  'search.tooShort': 'En az {min} karakter yaz.',
  'search.prompt':
    'Yazdığın kelimeler, büyük küçük harf fark etmeden, görebildiğin tüm kanallarda — yanıtlar ve çözülmüş thread’ler de.',
  'search.more': 'Daha fazla yükle',
  'state.search.empty.title': '“{words}” için sonuç yok',
  'state.search.empty.body': 'Görebildiğin tüm kanallara bakıldı. Silinmiş bir mesaj hiç bulunmaz.',
  'state.search.error.title': 'Aranamadı',
  'state.search.error.body': 'Sunucu yanıt vermedi. Kelimelerin duruyor; yeniden dene.',

  // ── Deep Work (D-108) ──────────────────────────────────────────────────
  'deepWork.on': '{until} saatine kadar Deep Work: hiçbir şey seni bölmüyor.',
  'deepWork.end': 'Bitir',
  'deepWork.failed': 'Deep Work değiştirilemedi.',
  'shortcuts.deepWork': 'Deep Work’ü başlat ya da bitir',

  // ── Notification level (D-107) ─────────────────────────────────────────
  'level.label': 'Bana haber ver',
  'level.button': 'Bildirimler: {level}',
  'level.all': 'Her mesaj',
  'level.mentions': 'Bahsetmeler ve yanıtlar',
  'level.none': 'Hiçbir şey',
  'level.all.short': 'her mesaj',
  'level.mentions.short': 'bahsetmeler ve yanıtlar',
  'level.none.short': 'hiçbir şey',
  'level.failed': 'Bildirim düzeyi değiştirilemedi.',

  // ── Inbox (D-106) ──────────────────────────────────────────────────────
  'inbox.title': 'Gelen kutusu',
  'inbox.lede': 'Sana söylenenler, en yenisi önce',
  'inbox.why.mention': '{name} senden bahsetti',
  'inbox.why.direct': '{name} sana yazdı',
  'inbox.why.reply': '{name} thread’ine yanıt verdi',
  'inbox.why.resolved': 'Sorun çözüldü',
  'inbox.why.channel': '{name} yazdı',
  'inbox.readAll': 'Tümünü okundu yap',
  'inbox.readFailed': 'Okundu yapılamadı.',
  'inbox.more': 'Daha fazla yükle',
  'state.inbox.loading': 'Gelen kutun yükleniyor',
  'state.inbox.error.title': 'Gelen kutun yüklenemedi',
  'state.inbox.error.body': 'Sunucu yanıt vermedi. Yeniden dene.',
  'state.inbox.empty.title': 'Seni bekleyen bir şey yok',
  'state.inbox.empty.body':
    'Biri senden bahsettiğinde, sana yazdığında ya da thread’ine yanıt verdiğinde burada görünür.',

  // ── Açık sorular (UX §4.4) ──────────────────────────────────────────────
  'questions.title': 'Açık sorular',
  'questions.lede': 'Yanıt almış çözülmemiş thread’ler, en yenisi önce',
  'questions.count': {
    other: '{count} açık soru',
  },
  'questions.footer':
    'Bunlar ekibinin henüz cevaplamayı bitirmediği sorular. Bir thread’i çözdüğünde bu listeden çıkar.',
  'questions.back': '{channel} kanalına dön',

  // ── Open questions, the list (D-98) ─────────────────────────────────────
  'questions.replies': '{replies} · {when}',
  'questions.more': 'Daha fazla soru yükle',
  'questions.unnamed': 'Artık göremediğin bir kanal',

  // ── Hatalar: her neden için bir cümle, bütün ekranlarda ortak ──────────
  'failure.network': 'Bağlantını kontrol edip tekrar dene.',
  'failure.session': 'Oturumun sona erdi. Devam etmek için tekrar giriş yap.',
  'failure.gone':
    'Bu artık kullanılamıyor. Kaldırılmış olabilir ya da erişimini kaybetmiş olabilirsin.',
  'failure.slow': 'Çok hızlı gidiyorsun. Biraz bekleyip tekrar dene.',
  'failure.tooLarge': 'Purlay’ın aldığından büyük.',
  'failure.refused': 'Bu reddedildi. Girdiğini kontrol edip tekrar dene.',
  'failure.generic': 'Bizim tarafta bir şey ters gitti. Birazdan tekrar dene.',
  'failure.signOut': 'Çıkış yapılamadı.',
  'failure.copy': 'Kopyalanamadı. Metni seçip kendin kopyala.',
  'connection.degraded': {
    other: '{count} kanal için canlı güncellemeler durdu',
  },
  'connection.stale': 'Gördüklerin güncel olmayabilir',
  'message.link.opens': '{host} adresini açar',

  // ── Tema ve dil ─────────────────────────────────────────────────────────
  'rail.label': 'Yerler',
  'settings.label': 'Ayarlar',
  'theme.label': 'Tema',
  'theme.system': 'Sistem',
  'theme.light': 'Açık',
  'theme.dark': 'Koyu',
  'language.label': 'Dil',
  'language.en': 'English',
  'language.tr': 'Türkçe',

  // ── Hesap ───────────────────────────────────────────────────────────────
  'user.menu': 'Hesap',
  'user.signOut': 'Çıkış yap',
  'user.signOutEverywhere': 'Her yerden çıkış yap',

  // ── Komut paleti (D-98) ─────────────────────────────────────────────────
  'palette.title': 'Komut paleti',
  'palette.placeholder': 'Bir kanala, kişiye ya da görünüme git…',
  'palette.empty': '“{query}” için eşleşme yok',
  'palette.group.views': 'Görünümler',
  'palette.group.channels': 'Kanallar',
  'palette.group.people': 'Kişiler',
  'palette.group.settings': 'Ayarlar',
  'palette.hint.move': 'gez',
  'palette.hint.open': 'aç',
  'palette.hint.close': 'kapat',

  // ── Komut paleti, devamı ────────────────────────────────────────────────
  'palette.description': 'Bir kanal, kişi ya da görünüm bulmak için yaz, sonra Enter’a bas.',
  'palette.listLabel': 'Sonuçlar',
  'palette.results': {
    other: '{count} sonuç',
  },
  'palette.view.feed': 'Akış',
  'palette.error': 'Açılamadı.',
  'palette.announce.channel': '{name} açıldı',

  // ── Klavye kısayolları (UX §7) ──────────────────────────────────────────
  'shortcuts.title': 'Klavye kısayolları',
  'shortcuts.description': 'Fareyle yapabildiğin her şeyi bunlarla da yapabilirsin.',
  'shortcuts.palette': 'Komut paletini aç',
  'shortcuts.reference': 'Bu listeyi göster',
  'shortcuts.close': 'En üstteki şeyi kapat',
  'shortcuts.move': 'Mesajlar arasında gez',
  'shortcuts.thread': 'Odaktaki thread’i aç ya da daralt',
  'shortcuts.reply': 'Odaktaki mesajı yanıtla',
  'shortcuts.edit': 'Kendi mesajını düzenle',
  'shortcuts.resolve': 'Odaktaki thread’i çöz ya da yeniden aç',
  'shortcuts.channels': 'Önceki ya da sonraki okunmamış kanal',
  'shortcuts.send': 'Mesajı gönder',
  'shortcuts.newline': 'Mesaja satır ekle',
  'shortcuts.group.navigation': 'Gezinme',
  'shortcuts.group.messages': 'Mesajlar',
  'shortcuts.group.composer': 'Mesaj kutusu',

  // ── Klavye kısayolları, devamı ──────────────────────────────────────────
  'shortcuts.codeSend': 'Kod bloğunun içinden gönder',
  'shortcuts.or': 'ya da',
} as const satisfies Catalogue;
