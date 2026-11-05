# Diğer ayar bölümleri: inceleme ve düzeltmeler

Tarih: 2026-11-05. Kapsam: önceki davet çalışmasına ek olarak Profil, Tercihler, Bildirimler, Klavye kısayolları, Oturumlar ve hesap, Hakkında, Genel, Üyeler, Entegrasyonlar, Denetim kaydı, Veri ve saklama ve sunucu yöneticisinin Sunucu sayfası.

## Yöntem ve değerlendirme

Kaynak kodu, HTTP sözleşmeleri, mevcut testler ve gerçek yerel API/veritabanıyla çalışan Chromium tarayıcı senaryoları incelendi. Çalışmaya başlarken mevcut 52 ayar sayfası erişilebilirlik kontrolü geçti; gecikme, başarısız yenileme ve gerçek uzunluktaki veriler için ek senaryolar gerekti.

Ana sorun eksik sayfalardan çok, görünürde tamamlanmış formların geciken veya başarısız isteklerde tutarsız davranmasıydı. Doğrulanan sorunlar düzeltildi; mevcut rol ayrımı, cihaz başına tercihler, bağlantıların gizli değerleri ve veri saklama kuralları korundu.

## Bulgular ve uygulanan düzeltmeler

| ID | Önem | Kanıt / konum | Önceki davranış | Düzeltme ve doğrulama |
|---|---|---|---|---|
| SET-01 | HIGH | `apps/web/src/features/settings/pages/quiet-hours-card.tsx:64` | Sessiz saatler okunamadığında sonsuz yükleme; boşaltılan saat alanı önceki değerin kaydedilmesine izin veriyordu. Kayıt sırasında yeni değişiklikler kaybolabiliyordu. | Hata ve Retry, boş saatler için alan hatası, geçersizken Save engeli ve işlem boyunca tutulan kontroller. Hem bileşen testi hem 320 pikselde gerçek tarayıcı ve API ile doğrulandı. |
| SET-02 | HIGH | `apps/web/src/data/cache.ts:39`, `apps/web/src/data/queries.ts:62`, `apps/web/src/features/settings/pages/profile.tsx:107` | Profilin saat dilimi değişse bile süresiz taze sayılan sessiz saatler önbelleği eski saat diliminde kalıyordu. | Yerel profil kaydı ve aynı kişinin başka cihazdan gelen profil yenilemesi, sessiz saatlerin saat dilimini güncelleyip veriyi tekrar okuyor. İki regresyon testi ve sayfa yenilemeden Profil → Bildirimler tarayıcı akışı geçti. |
| SET-03 | MEDIUM | `apps/web/src/features/settings/pages/notifications.tsx:186`, `pages/missed-mail-card.tsx` | Aynı bildirim tercihi için birden fazla istek örtüşebiliyor, eski sonuç yeni tercihin üzerine yazılabiliyordu. | Kanal bazında bekleme; e-posta anahtarı için tek bekleyen işlem. Seçim hemen boyanıyor, yanıt gelene kadar ilgili kontrol tutuluyor; hatada eski değer geri geliyor. |
| SET-04 | MEDIUM | `apps/web/src/features/settings/pages/general.tsx:95`, `pages/integrations.tsx:204`, `pages/profile.tsx:208`, `pages/retention.tsx` | Kayıt sürerken alan veya yardımcı eylem değiştirilebiliyor; kaydın yanıtı yeni yazılan değeri silebiliyor veya ikinci işlemi başlatabiliyordu. | Ad, profil saat dilimi kısayolu, GitHub token/kesme işlemi ve saklama seçimi beklerken ilgili kontroller tutuluyor; başarısızlıkta yazılan değer kalıyor. Geciktirilmiş yanıt testleri geçti. |
| SET-05 | MEDIUM | `apps/web/src/features/settings/pages/members.tsx:98` | Aynı üye için rol değişimi ve çıkarma işlemi çakışabiliyordu. | Durum kişi ve işlem türü bazında izleniyor. O kişinin kontrolleri bekliyor; başka üyeler yönetilebiliyor. Başarılı ve başarısız akışlar mevcut ve yeni testlerle doğrulandı. |
| SET-06 | HIGH | `apps/web/src/features/settings/pages/server-policies.tsx:66`, `features/settings/server-parts.tsx`, `pages/server.tsx:60` | Giriş ve oturum politikalarının istekleri örtüşebiliyor; kabul edilmiş değişiklik, yenileme hatasında eski seçenek gibi gösterilebiliyor; hata görünmeyebiliyor veya yanlış biçimde hiçbir şeyin değişmediğini söyleyebiliyordu. | İlgili gruplar bekliyor; başarılı politika cevabı önbelleğe işleniyor. Yenileme hatası son bilinen ayarları koruyup doğru açıklamayla Retry sunuyor. Regresyon testleri geçti. |
| SET-07 | HIGH | `apps/web/src/features/settings/pages/server-accounts.tsx:42` | Önceki arama sonuçları yeni arama yüklenirken askıya alınabiliyor; askıya alma sürerken başka işlem veya iptal seçilebiliyordu. | Eski arama sonuçlarının eylemleri yükleme boyunca kapalı. Bir hesap değişikliği tamamlanana kadar ilgili hesap eylemleri tutuluyor. İki regresyon testi geçti. |
| SET-08 | MEDIUM | `apps/web/src/features/settings/pages/server-channels.tsx`, `pages/server-google.tsx`, `pages/server-oidc.tsx`, `pages/server-github-app.tsx`, `features/setup/parts.tsx` | Bağlantı sınanırken kimlik bilgileri değiştirilebiliyor; kabul edilen yanıt yeni yazılmış gizli değeri temizleyebiliyordu. | İstek boyunca metin alanları salt okunur, ilgili seçimler devre dışı. Ortak MailServerField bu durumu iletebiliyor. GitHub ve SMTP için gecikmeli yanıt regresyonu ve mevcut sağlayıcı testleri geçti. |
| SET-09 | MEDIUM | `apps/web/src/features/settings/pages/account.tsx:78` | Kurumsal tek oturum açma bağlı hesapta, e-posta satırı bir bağlantının giriş yapacağını söyleyerek sağlayıcı satırıyla çelişiyordu. | Hesabın gerçek bağlı yöntemine göre açıklama; olmayan GitHub bağlantısına yönlendiren varsayılan açıklama kaldırıldı. Regresyon testi geçti. |
| SET-10 | MEDIUM | `apps/web/src/features/settings/pages/archived-channels.tsx:42`, `pages/audit.tsx:517` | Geri yüklenen kanal liste yenilenene kadar tekrar işlem alabiliyor; mevcut denetim kaydı yenilenemediğinde hata saklanabiliyordu. | Başarılı geri yükleme hemen önbelleğe yansıyor; yenileme boyunca işlem korunuyor. Denetim kaydı mevcut satırlarla birlikte yenileme hatası ve Retry gösteriyor. Regresyonlar geçti. |
| SET-11 | MEDIUM | `apps/web/src/features/settings/page.tsx:165`, `apps/web/src/ui/select.tsx`, `ui/text-field.tsx` | Altı ayar sayfasındaki düzenlenebilir alanlar 13–14 piksel kalıyordu. Uzun giriş adresi masaüstünde ve telefonda kartın dışına taşıyabiliyordu. | Dar ekranda mevcut token'larla en az 16 piksel; ayar kontrol sütunu sınırlandırılıp dar ekranda tam genişliğe oturtuldu. 320 piksel kontrolleri, uzun gerçekçi e-posta adresi ve kurulu sessiz saatlerin yerleşimi tarayıcıda doğrulandı. |

## Bölüm bazında sonuç

| Bölüm | İncelenen ana iş ve kanıt |
|---|---|
| Profil | Ad ve profil kaydı, bekleyen işlemler, saat dilimi; gerçek API ile karşı sekmeye yansıma ve sessiz saatlere geçiş. |
| Tercihler | Cihaza özgü tema/dil seçimi, mevcut bileşen testleri, iki temada erişilebilirlik ve 320 piksel yerleşim. Yeni işlev kusuru doğrulanmadı. |
| Bildirimler | Deep Work, cihazın kullanılabilirliği, kanal/e-posta tercihleri, sessiz saatlerin hata/boş saat/bekleme/saat dilimi durumları. |
| Kısayollar | Statik referans, gezinme, erişilebilirlik ve dar ekran. Yeni işlev kusuru doğrulanmadı. |
| Oturumlar ve hesap | Oturum sonlandırma, giriş yöntemi açıklamaları, parola/ikinci adım ve kişisel veri kartları; uzun adres yerleşimi. |
| Hakkında | Sürüm, bilinmeyen en yeni sürüm, hata/yeniden deneme ve kaynak bağlantıları; mevcut testler ve tarayıcı kontrolü. Yeni işlev kusuru doğrulanmadı. |
| Genel | Ad kaydı, adres kopyalama, arşivden geri getirme, başka sekmeye yansıma, mevcut silme onayları. |
| Üyeler | Rol, çıkarma onayı, son sahip ve yetki kuralları, kişi bazında işlem kilidi, arama/filtre. |
| Entegrasyonlar | Token kaydı, alan hataları, bağlantı kesme ve işlem çakışmaları; mevcut GitHub App kartları. |
| Denetim kaydı | Liste, filtre, eski sayfa, CSV/NDJSON indirme ve başarısız yenileme. |
| Veri ve saklama | Kota, saklama aralığı ve kısaltma uyarısı, dışa aktarma kartları; ilgili bileşen ve gerçek API testleri. |
| Sunucu | Yönetici/çalışma alanı sahibi ayrımı, sağlayıcı formları, politikalar, oturum süreleri, hesap araması/askıya alma ve 320 piksel kontroller. |

## Çalıştırılan kontroller

- Başlangıç tarayıcı kontrolü: `settings-a11y.e2e.ts`, iki tema × iki genişlik, **52 geçti**.
- Hedefli ayar/profil/önbellek/sorgu/kurulum testleri: **448 geçti, 0 başarısız**. Son yenileme hata metni ayrıca tek başına yeniden doğrulandı.
- `settings-a11y.e2e.ts settings-resilience.e2e.ts workspace-settings.e2e.ts profiles.e2e.ts members.e2e.ts account.e2e.ts retention.e2e.ts audit.e2e.ts server-settings.e2e.ts`: **149 geçti, 3 kasıtlı atlama**. Atlamalar, izole sunucu yönetimi senaryosunun yalnızca bir projede çalışması içindir.
- Ek `export.e2e.ts personal-export.e2e.ts two-factor.e2e.ts session-lifetime.e2e.ts sign-in-policy.e2e.ts` koşusu: **11 geçti, 9 kasıtlı atlama**. Çalışma alanı ve kişisel veri dışa aktarma dört projede, izole güvenlik politikaları kendi belirlenmiş projelerinde çalıştı. İki ana koşuda toplam **160 başarılı tarayıcı senaryosu**, **12 kasıtlı atlama** var.
- Bu tarayıcı koşusu iki temayı, 1440/820 piksel projelerini, ek olarak 320/390 piksel kontrollerini, uzun adresi ve gerçek API ile başarısız sessiz saatler okuması → Retry → boş saat → kayıt → sayfa yenilemeden saat dilimi değişimini kapsıyor.
- TypeScript (iki derleyici), ESLint, Knip, Prettier, doküman çapraz referansları ve `git diff --check`: başarılı. Son testteki hata çıktısını küçük tutan assertion düzenlemesi ürün davranışını değiştirmedi.
- Kaynak haritalı üretim derlemesi ve web bütçesi: başarılı; ilk JavaScript **245,81 KB gzip / 400 KB**.
- Temsilî dar ekran görünümleri incelendi: [Profil](settings-profile-mobile.png), [Üyeler](settings-members-mobile.png), [Bildirimler](settings-notifications-mobile.png).

## Son doğrulama

Son kod üzerinde `PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH" bun run test:all` başarılı tamamlandı: **19.222 geçti, 1 kasıtlı atlama, 0 başarısız**, 717 dosya ve 101.894 assertion. PostgreSQL ve Redis erişilebilirdi; birim ve entegrasyon testleri birlikte, kapsam eşiği denetlenerek çalıştı. Genel kapsam: **fonksiyonlar %99,90, satırlar %99,87**. Tek atlama, yalnızca hazırlık veritabanında çalışması gereken son migration tablo kontrolüdür.

İki ana tarayıcı koşusunda **160 senaryo geçti**, projelere özgü güvenlik/sunucu senaryolarında **12 kasıtlı atlama** var. Derleme, tip, lint ve biçim kontrolleri de başarılı. Bu incelemede doğrulanan 11 sorun grubu giderildi; kapsam içindeki değişiklikler yerel inceleme için hazır. Canlıya dağıtım yapılmadı.

## Sınırlar

Canlı ortama dağıtım yapılmadı. Üretimde oturum gerektiren sayfalar, gerçek sağlayıcı hesapları, işletim sisteminin bildirim teslimatı ve ekran okuyucuyla manuel kullanım bu incelemede doğrulanmadı. Chromium'da ölçülen 16 piksel alan yazısı, Safari/iOS'ta doğrudan yapılmış bir yakınlaştırma testi olarak sunulmuyor.

Yeni veri saklama, rol veya sağlayıcı modeli eklenmedi; düzeltmeler mevcut ayarların sözleşmelerini ve işlemlerini tamamlıyor.
