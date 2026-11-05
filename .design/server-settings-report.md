# Sunucu ayarları: ayrıntılı inceleme

Tarih: 2026-11-05. Önceki genel ayar incelemesine ek çalışma. Kapsam: GitHub/Google/OIDC, SMTP, GitHub App, kayıt/giriş ve oturum politikaları, çalışma alanı oluşturma yetkisi, hesap arama ve askıya alma.

Mevcut ayar kartları ve sunucu yöneticisi yetkisi korundu. İnceleme kaynak kodu, sözleşmeler, bileşen testleri, gerçek PostgreSQL üzerinde servis/HTTP testleri ve yerel sunucuyla Chromium akışlarını kapsıyor. Önceki `.design/settings-report.md` bulguları uygulandı; bu rapor ek kusurları kaydeder.

## Ek bulgular

| ID | Önem | Kanıt | Önceki davranış | Düzeltme |
|---|---|---|---|---|
| SRV-01 | HIGH | `server-parts.tsx`, beş sağlayıcı kartı ve `server-policies.tsx`; kabul edilen işlemden sonra 503 ile bileşen ve SMTP tarayıcı senaryoları | Sağlayıcı bağlama/kesme veya çalışma alanı oluşturma yetkisi sunucuda değiştiği halde, sonraki okuma hatasında kart eski durumu gösteriyordu. | Kabul edilmiş değişikliğin yalnızca herkese açık görünümü önbelleğe işleniyor; eski okuma iptal ediliyor, kanal ve yeniden giriş durumları güncelleniyor. Sonraki okuma hatası Retry sunuyor. Giriş yöntemleri sorgusu da geçersiz kılınıyor. Test, SMTP kullanıcı/parolası ve diğer gizli değerlerin önbelleğe girmediğini doğruluyor. |
| SRV-02 | MEDIUM | GitHub, Google, OIDC, SMTP ve GitHub App iptal/açma testleri | Cancel formu gizliyor, yeniden açıldığında secret, SMTP adresindeki parola ve App anahtarları kalıyordu. | İptal alanları sıfırlıyor; yeniden açılış son bilinen herkese açık ayarları alıp boş gizli alanlarla başlıyor. Başarısız denemede veri korunuyor. |
| SRV-03 | MEDIUM | `DisconnectDialog`, last-channel → Cancel → yeniden açma regresyonu | Önceki last-channel yanıtının zorunlu onay durumu ve hata bilgisi sonraki açılışa taşınıyordu. | Her açılış yeni bir onay oturumu. Önceki iptal, sonraki işleme onay sayılmıyor. Bekleyen işlemde kapatma engeli korunuyor. |
| SRV-04 | MEDIUM | Dışarıdan yenilenen sorgu verisiyle iki regresyon | Sağlayıcı kartı yeni Client ID gösterirken değiştirme formu eskisini açıyordu. Çalışma alanı oluşturma yetkisi, kullanıcı düzenlememiş olsa bile eski seçenekte kalıyordu. | Değiştirme formu açılırken güncel görünümden başlıyor. Yetki seçimi düzenleme başlayana kadar sunucu verisini izliyor; gerçek taslak yenilemede korunuyor. |
| SRV-05 | MEDIUM | Gerçek Chromium'da 320 pikselde açılmış formun kart genişliği kontrolü önce başarısız oldu | Kaydet/iptal eylemleri açık sağlayıcı formlarında kart dışına taşıyordu; önceki dar ekran testi kapalı formları kapsıyordu. | Beş formda eylemler gerektiğinde alt satıra geçiyor. Gerçek tarayıcıda her form açılıp doldurularak genişlik ve iptal davranışı doğrulandı. |
| SRV-06 | MEDIUM | `server-accounts.tsx`, başarısız GET regresyonu | Hesap listesi okunamadığında işlem reddi için yazılmış açıklama kullanılıyordu; önceki değişikliğin sonucu hakkında yanlış izlenim verebiliyordu. | Okuma hatasına özel TR/EN açıklama ve mevcut Retry. |

## Çalıştırılan doğrulama

- İlk ek regresyon koşusunda 13 gerçek hata doğrulandı; SMTP testinin alan/eylem adı düzeltildi. Sonraki iki dışarıdan yenileme regresyonu da düzeltmeden önce başarısız oldu. Anahtar onarımının yeniden giriş uyarısını temizlemesi ayrıca test edildi.
- Beş dosyada sunucu bileşen/istemci/bağlam ve gerçek servis/HTTP testleri: **197 geçti, 0 başarısız**. Bunların 17'si bu ayrıntılı incelemede eklenen regresyon senaryoları.
- Yerel gerçek SMTP sunucusu: erişilemeyen adres → hata → doğru adres → deneme mesajı ve kayıt → ayar GET 503 → bağlı görünümün korunması → Retry → bağlantı kesme → GET 503 → bağlantısız görünümün korunması → Retry. Giriş yöntemlerinin gerçek API yanıtı her iki değişikliği doğruladı.
- 320 pikselde beş bağlantı formu açıldı, gizli alanlar dolduruldu, iptal edilip boş açıldığı kontrol edildi. Önceki 320/390 piksel kontrolleri de korundu.
- `server-settings.e2e.ts sign-in-policy.e2e.ts session-lifetime.e2e.ts`, `chromium-light`: **3 geçti**. Başlangıçta ortak test Redis'inin hız sınırına takılan kurulum akışı, testler için Redis kapatılmış ayrı sunucularla tekrar çalıştırıldı. Genel test koşusu PostgreSQL ve Redis'i kullanıyor; üretim hız sınırları değiştirilmedi.
- `oidc.e2e.ts github-app.e2e.ts`, `chromium-light-narrow`: **2 geçti**. Yönetici OIDC sağlayıcısını bağlayıp yeni bir kişinin girişini, GitHub App'i bağlayıp kurulum ve kişi adına issue açma akışını tamamladı. Bu incelemede son kod üzerinde toplam **5 başarılı tarayıcı senaryosu** var.
- TypeScript (iki derleyici), ESLint, Knip, Prettier, doküman çapraz referansları ve `git diff --check`: başarılı.
- Kaynak haritalı üretim derlemesi ve web bütçesi başarılı: ilk JavaScript **245,82 KB gzip / 400 KB**.
- [SMTP kartının dar ekran görünümü](server-email-mobile.png) görsel olarak incelendi.

## Son durum

Son kod üzerinde `PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH" bun run test:all` başarılı: **19.241 geçti, 1 kasıtlı atlama, 0 başarısız**; 717 dosya, 101.940 assertion. PostgreSQL ve Redis kullanıldı; birim ve entegrasyon testleri birlikte, kapsam eşiği denetlenerek çalıştı. Genel kapsam: **fonksiyonlar %99,90, satırlar %99,87**. Tek atlama, yalnızca hazırlık veritabanında çalışması gereken son migration tablo kontrolüdür.

Sunucuya yönelik 197 hedefli test, beş tarayıcı akışı, iki TypeScript derleyicisi, ESLint, Knip, Prettier, doküman denetimi, üretim derlemesi ve web bütçesi başarılı. Bu incelemede doğrulanan altı ek sorun grubu giderildi. Değişiklikler yerel inceleme için hazır; canlıya dağıtım yapılmadı.

## Sınırlar

Canlıya dağıtım yapılmadı. SMTP denemesi yerel gerçek SMTP protokolü üzerinden çalışan test sunucusuna yapıldı; üretim sağlayıcısı ve gerçek posta kutusuna teslimat doğrulanmadı. GitHub/Google/OIDC için mevcut test çiftleri ve HTTP/servis testleri kullanıldı; gerçek sağlayıcı hesaplarıyla yeni bağlantı kurulmadı. Chromium kontrolleri, manuel ekran okuyucu veya Safari/iOS doğrulaması yerine geçmez.
