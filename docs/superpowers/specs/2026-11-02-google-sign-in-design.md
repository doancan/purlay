# Google ile giriş — tasarım

Tarih: 2026-11-02 · Durum: onaylandı (2026-11-02) · Karar kaydı olarak: D-250 (uygulamayla birlikte yazılacak)

## Amaç ve neden

Giriş ekranında GitHub'ın yanında ayrı bir **"Google ile devam et"** seçeneği. Purlay'e bugün GitHub, e-posta
bağlantısı ve tek bir genel "tek oturum açma" (OIDC, D-200) yuvasıyla giriliyor. Google hesabı olan ama GitHub'ı
olmayan ya da kullanmak istemeyen ekip üyeleri için doğrudan bir kapı isteniyor.

Kullanıcının kararları:

- **Ayrı bir seçenek.** Genel OIDC yuvasına Google yazılarak yapılmayacak: o yuva şirket girişleri (Okta, Entra ID…)
  için boş kalır, ve bir sunucuda GitHub, Google, şirket girişi ve e-posta aynı anda açık olabilir.
- **Hem kendi sunucusunu kuranlar hem bulut.** Kendi kuran ekip Google'dan aldığı istemci kimliği ve gizli anahtarla
  açar; bulutta işletmeci bir kez girer ve herkese hazır gelir. Ayarlanmamışsa buton hiç görünmez.

Kullanıcının onayladığı davranış (sohbetteki özet):

- Google'ın OpenID Connect'i kullanılır; D-200'deki doğrulama kontrollerinin aynısı, sabit `https://accounts.google.com`
  sağlayıcısına uygulanır. Yeni bir giriş yolu sıfırdan yazılmaz.
- Aynı adresle GitHub ya da e-postayla açılmış bir hesap, Google ile girildiğinde **aynı hesaba** düşer — yalnızca
  Google adresi doğrulamışsa (`email_verified`), mevcut hesabın adresi de doğrulanmışsa (GitHub'daki kural, D-179 §5)
  **ve adres Google'ın gerçekten sahibi olduğu bir adresse** (aşağıda "Adresle bağlama").
- Butona her Gmail sahibi basabilir, ama içeri kimin gireceğini mevcut kurallar belirler: davet pasaportu,
  kayıt politikası, `WORKSPACE_CREATORS`. Google ek bir kapı açmaz.
- Google, şirket girişi gibi değil **GitHub gibi** davranır (aşağıda "E-posta bağlantısı"): Google ile *açılmış* bir
  hesaba giriş bağlantısı gönderilmez, "Google ile gir" mektubu gider; e-postayla açılıp sonra Google bağlanmış bir
  hesap bağlantısını korur. (Sohbette önce "bağlantı çalışmaya devam eder" denmişti; kullanıcı GitHub'la tutarlılığı
  seçerek bunu düzeltti.)
- Google'dan profil fotoğrafı alınmaz (D-200 §7 ile aynı gerekçe: herkesin tarayıcısı Google'a istek atardı).

## Hedefler

1. Sunucu Google'ı ayrı bir sağlayıcı olarak tanır: `provider_id = 'google'`, rotalar `GET /auth/google` ve
   `GET /auth/callback/google`.
2. Yapılandırma GitHub'ınki gibi: `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` başlangıç tohumu (ikisi ya da hiçbiri),
   sonrasında Yönetim → Sunucu'da bir kart: bağlan (önce denenir), değiştir, bağlantıyı kes.
3. Giriş, kayıt ve davet ekranlarında Google butonu; Hesap sayfasında "Google bağlı" satırı.
4. Hem web hem yerel uygulamaların el değiştirmesi (D-191) değişmeden çalışır.
5. Belgeler: D-250, `CONFIG.md`, `API.md`, `UX.md`, `SCHEMA.md`, `docs/changelog/changes.md`, `.env.example` /
   `docker-compose.production.yml`.

## Hedef olmayanlar

- **Alan adıyla giriş kısıtlaması (`hd`, "yalnızca @sirket.com girebilir").** (`hd` yalnızca adresle *bağlamada*
  kullanılır, kimin gireceğinde değil.) D-200 bir izin listesini reddetti; kimin gireceği davet ve
  kayıt politikasıyla belirlenir. İleride eklenebilir, bu tasarım engellemez.
- **Birden çok genel OIDC sağlayıcısı.** Google özel, sabit bir sağlayıcı; genel yuva yine tek.
- **Kurulum sihirbazında Google adımı.** OIDC'deki gibi: ilk sunucu parola, GitHub ya da e-postayla kurulur; Google
  tohum değişkenlerle ya da Yönetim → Sunucu'dan bağlanır. *(Benim kararım.)*
- **Google'dan fotoğraf, takvim, Drive ya da başka kapsam.** Kapsam yalnızca `openid email profile`.

## Anti-hedefler (çalışsa bile başarısızlık sayılır)

- Google hesabı açabilen birinin, adresini doğrulamadan başkasının Purlay hesabına girebilmesi (D-200 §3'ün kapattığı
  ele geçirme).
- Şirket girişine (OIDC) bağlı bir hesaba Google üzerinden adresle bağlanılabilmesi — D-200 §6, GitHub için nasıl
  kapalıysa Google için de kapalı olmalı.
- Google'ın sunucusuna, biri butona basmadan istek gitmesi (açılışta keşif yok; D-200'deki kural).
- Tarayıcının Google'dan bir şey yüklemesi (logo, font, fotoğraf) — D-39 / CSP `img-src 'self'`.
- Genel OIDC yuvasının davranışında herhangi bir değişiklik.

## Kısıtlar

- Doğrulama çekirdeği `apps/api/src/modules/auth/oidc.ts` (`createOidcProvider`) zaten genel; sağlayıcı kimliği
  (`OIDC_PROVIDER_ID = 'oidc'`), hata kodları ve log önekleri sabit. Bunlar parametre olur; OIDC'nin davranışı birebir
  aynı kalır (mevcut testler bunu tutar).
- Google `iss` alanını tarihsel olarak hem `https://accounts.google.com` hem `accounts.google.com` olarak verir
  (Google'ın belgesi ikisini de kabul etmeyi söyler). Google sağlayıcısında ikisi de kabul edilir; genel OIDC'de
  kesin eşitlik kuralı aynen kalır.
- Hesap anahtarı: `provider_id = 'google'`, `account_id = sub`. Veren sabit olduğu için `"<issuer>|<sub>"` öneki
  gerekmez. *(Benim kararım; `iss` iki biçimde gelebildiği için önekli anahtar tutarsız da olurdu.)*
- PR üretim kodu bütçesi 400 satır (`scripts/check-pull-request.ts`). Bu iş muhtemelen aşar: ya `large-change`
  etiketiyle tek PR, ya da sunucu ve web diye iki PR. Planlama karar verir.
- Lint `no-raw-visual-value` düz renk değerlerini reddeder; `lucide-react` yalnızca `components/icon.tsx`'te.

## Nasıl — karara bağlananlar

### Sunucu

- **Sağlayıcı.** `createOidcProvider` bir `id` (ve hata/log adları) alır. Google için sabit issuer
  `https://accounts.google.com`, kapsam `openid email profile`, aynı PKCE + `nonce` + imza + süre kontrolleri,
  aynı keşif ve anahtar önbellekleri. Keşif yalnızca butona basılınca yapılır.
- **Kayıt.** Better Auth'a OIDC'ninki gibi bir eklentiyle (`purlay-google`) verilir; `/callback/:id` genel olduğundan
  `GET /auth/callback/google` kendiliğinden gelir. `GET /auth/google` başlangıç rotası `app.ts`'e eklenir; hata
  kancası (`app.ts`'teki `SIGN_IN_CALLBACK || OIDC_CALLBACK` kontrolü) Google'ın geri dönüşünü de kapsar.
- **Kimlik çakışması.** `refusedIdentityConflict` (`better-auth.ts`) bugün yalnızca `'oidc'` ve `'github'`
  için çalışıyor; `'google'` eklenir: bir hesabın Google'da tek kimliği olur, ve OIDC'ye bağlı bir hesaba Google adresle
  bağlanamaz. `lostSignUpRace` ve `round.oidcAccountId` tek yuvaya göre yazılmış; Google için de çalışacak hale gelir.
- **Adresle bağlama — yalnızca Google'ın sahibi olduğu adresler (kullanıcının kararı).** Google, `email_verified`'ı
  dış bir adres için yalnızca hesap açılırken bir kez kontrol eder; o adres sonradan başkasına verilmiş olabilir.
  Google'ın kendi rehberine göre yetkili olduğu adresler: `@gmail.com` (ve `@googlemail.com`) ile `hd` iddiası taşıyan
  ve adresin alan adı `hd` ile aynı olan Workspace adresleri. Google'ın bilinmeyen bir kimliği **mevcut bir hesaba**
  adresle yalnızca bu durumlarda bağlanır. Diğer adreslerde: o adresle bir hesap varsa bağlanmaz ve hiçbir şey
  yapılmaz, kişiye `email-unverified` söylenir; o adresle hesap yoksa yeni hesap normal kurallarla (davet, kayıt
  politikası) açılabilir. Bu kural yalnızca Google sağlayıcısında; GitHub ve genel OIDC değişmez.
- **E-posta bağlantısı — GitHub gibi (kullanıcının kararı).** D-138 §2: GitHub'ın *açtığı* hesaba giriş bağlantısı
  gönderilmez, "GitHub ile gir" mektubu gider (`fateOf` / `madeByGitHub`, `magic-link.ts`). Google için de aynısı:
  Google'ın açtığı hesaba "Google ile gir" mektubu (İngilizce ve Türkçe), bağlantı yok. E-postayla açılıp sonra Google
  bağlanmış hesap bağlantısını korur. Bunun için hesabı Google'ın açtığı kaydedilir — GitHub'daki
  `github_id` / `github_connected_at` gibi; migrasyon `0078`'e bir sütun (ör. `users.google_made_at` ya da
  `accounts` üzerinden türetme — hangisi `madeByGitHub`'ın bugünkü yöntemine uyuyorsa). Google bağlantısı kesilirse
  (sunucudan) bu hesaplar için bağlantı yeniden açılır: "giden bir kapı kimseyi dışarıda bırakmaz" (D-200 §6 ile aynı).
- **Adres güncellenmesi.** Google ile girişte `users.email` güncellenmez; GitHub'ın bugün yaptığıyla aynı yapılır
  (inşa eden `madeByGitHub` ve GitHub girişindeki adres davranışını izler).
- **Ayarlar.** Migrasyon `0078`: `server_settings.google_client_id`, `google_client_secret_encrypted` (ikisi ya da hiçbiri
  CHECK'i; gizli anahtar sütun adıyla mühürlenir, GitHub'ınki gibi). `SettingsPatch` / `SettingsSeed` / `envSeedOf` /
  `importFromEnvOnce` / `SealedSettingName` genişler. `config.ts`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (ikisi ya
  da hiçbiri, aksi halde açılmaz; gizli anahtar log'dan gizlenir).
- **Yönetim API'si.** `POST /api/server/google` (bağlan/değiştir; önce denenir), `DELETE /api/server/google`
  (`confirmLastChannel` ile). Deneme OIDC'ninkiyle aynı: keşif belgesi, anahtar seti, ve kimsenin almadığı bir kodla token
  isteği — `invalid_grant` çiftin doğru olduğunu, `invalid_client` gizli anahtarın reddedildiğini söyler. "Son giriş
  yolu" sayımı ve `hasProvider` (parolaları kapatma, kayıt politikası) Google'ı da sayar.
- **Denetim izi.** `server.google_connected`, `server.google_disconnected`, kaydeden işlemin içinde, değer olmadan.
  (`0054_server_audit_log.sql`'de `action` üzerinde CHECK yok; yalnızca `ServerAuditAction` birleşimi genişler.)
- **Sözleşme (`@purlay/types`).** `AuthMethods.google: boolean`, `MySignIn.google: boolean`, `ServerSettings`'te
  Google kanalı ve `googleCallbackUrl` (yöneticinin Google Console'a yapıştıracağı adres), `ServerGoogleRequest`.
  `GOOGLE_START_PATH = '/auth/google'`, `GOOGLE_CALLBACK`. `SignInFailure`'a `google-unavailable` (Google cevap vermedi
  ya da inanılmayan bir token gönderdi; kişiye hangisi olduğu söylenmez). `email-unverified` paylaşılır.
- **Sözleşme sürümü.** Artırılmaz: `API.md` ve D-186'ya göre bir ekleme `CONTRACT_VERSION`'ı artırmaz. Yeni
  sabitler (`GOOGLE_START_PATH`, `GOOGLE_CALLBACK`) `apps/api/src/contract/bundle.ts`'teki `CONSTANTS` listesine eklenir.

### Web

- **Buton.** `provider-button.tsx` üzerinden `google-button.tsx` (`/auth/google`), metin "Google ile devam et" /
  "Continue with Google". Giriş, kayıt ve davet ekranlarında (davette `before={askPassport}` ile, diğerleri gibi).
- **Sıra:** şirket girişi (varsa) → GitHub → Google → e-posta. *(Benim kararım: ürün geliştirici ekipler için ve
  GitHub birincil kapı; şirket girişi varsa en üstte kalır, bugünkü gibi.)*
- **Logo.** Google'ın marka kuralları "Google ile giriş" butonunda çok renkli "G"yi ister; Google, OAuth uygulamasını
  doğrularken buna bakar. Logo `components/icon.tsx`'e satır içi SVG olarak eklenir (dışarıdan yükleme yok). Dört marka
  rengi `packages/tokens/tokens.json`'a **marka rengi** olarak eklenir (lint düz renkleri reddettiği için); tema ile
  değişmezler. *(Benim kararım: tek renkli bir "G" lint'e takılmazdı ama Google'ın kurallarına aykırı.)*
- **Yönetim → Sunucu.** OIDC kartının yanında bir Google kartı: istemci kimliği, gizli anahtar, kopyalanabilir geri
  dönüş adresi, bağla / değiştir / bağlantıyı kes, hata nedenleri (`setup.google.reason.*`). Bağlantıyı kesme
  iletişim kutusu ve "son giriş yolu" listeleri Google'ı tanır.
- **Hesap sayfası.** "Google bağlı" satırı, OIDC'ninki gibi.
- **Metinler** İngilizce ve Türkçe (`en.ts`, `tr.ts`); hata cümleleri `UX.md` §11'e eklenir.

### Belgeler

- D-250 karar kaydı: bağlam, kararlar, reddedilenler (genel yuvayı Google'a vermek; `hd` ile *giriş* kısıtlaması;
  her doğrulanmış adrese güvenmek; Google'ın açtığı hesaba bağlantı göndermek; birden çok OIDC yuvası; tek renkli logo;
  sihirbaz adımı), geri dönüş maliyeti. D-200'e bir "ilgili" satırı.
- `CONFIG.md` tablosu ve "nerede yaşar" listesi; `API.md` rotaları; `SCHEMA.md` sütunları; changelog **Added**.
- Bulut/kendi sunucusu için işletmeci notu: Google Cloud Console'da OAuth istemcisi (Web), yetkili geri dönüş adresi
  `APP_URL/auth/callback/google`, onay ekranı "External". `openid email profile` hassas olmayan kapsamlar; yine de
  uygulama "Testing" durumundayken yalnızca test kullanıcıları girebilir, "In production"a alınmalı (marka doğrulaması).

### Testler

- `oidc.ts`'in parametreleşmesi: mevcut `oidc.test.ts` ve `oidc-sign-in.integration.test.ts` değişmeden geçer.
- Google sağlayıcısı: `oidc-stub.ts` ile her iki `iss` biçimi, `email_verified` yok/false, yanlış `aud`, eski token,
  yanlış `nonce`; mevcut hesaba adresle bağlanma: `@gmail.com` ve `hd`'li Workspace adresi bağlanır; `hd`'siz dış adres
  ve alan adı `hd`'ye uymayan adres bağlanmaz (`email-unverified`, hiçbir satır değişmez); iki taraftan biri doğrulanmamışsa
  `email-unverified` / `email-taken`; Google'ın açtığı hesaba bağlantı yerine "Google ile gir" mektubu, e-postayla açılmış
  hesaba bağlantı, Google bağlantısı kesilince yeniden bağlantı; OIDC'ye bağlı hesaba Google ile bağlanma reddi; bir hesaba ikinci Google kimliği reddi; davet
  pasaportuyla kayıt; ayarlanmamışken `GET /auth/google` → `404`.
- Ayarlar/tohum/yapılandırma: ikisi-ya-da-hiçbiri, mühürleme, bir kez içe aktarma; yönetim API'si deneme sonuçları,
  son giriş yolu, denetim izi.
- Web: buton sırası ve görünürlüğü (`sign-in-screen`, `sign-up-screen`, `invite-screen`), Google kartı, hesap satırı,
  Türkçe metinler; `auth-methods.test.ts` ve `e2e/sign-in.e2e.ts`'teki tam `AuthMethods` beklentileri güncellenir.
  Demo sunucu Google'ı açmadığı sürece ekran görüntüsü tabanları değişmez.
- `scripts/mutations.ts`: Google için `refusedIdentityConflict` kapsamına, yetkili-adres kontrolüne ve `fateOf`'un
  Google dalına birer mutant.

## İnşa edene bırakılanlar

- `oidc.ts`'i nasıl parametreleyeceği (bir `id` + etiket nesnesi, ya da küçük bir sağlayıcı tanımı tipi), tek yuvalı
  `round.oidcAccountId` / `lostSignUpRace`'in nasıl genelleşeceği.
- Yönetim kartında OIDC kartıyla ne kadar kod paylaşılacağı.
- PR'ın tek mi (`large-change`) yoksa sunucu + web diye ikiye mi bölüneceği.
- Hata cümlelerinin tam metni (mevcut OIDC cümlelerinin tonunda).
