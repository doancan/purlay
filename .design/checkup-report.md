# Davet akışı incelemesi

Tarih: 2026-11-05. İncelenen kaynak: `main`, `d0d29581` (`git pull --ff-only` sonrası).

Bu dosya ilk incelemeyi ve uygulama sonrası doğrulamayı içerir. Güncel durum son bölümdedir.

## Kapsam ve yöntem

Hedef: `/w/mess/settings/invitations`; bağlantılı çalışma alanı davet penceresi, ortak React hook'u, HTTP sözleşmeleri ve e-posta gönderimi. Ürün dosyaları değiştirilmedi.

Canlı URL, ayrı Chromium oturumunda `/sign-in` adresine yönlendi. Dolayısıyla oturum gerektiren canlı sayfanın görünümü doğrulanmadı. Canlı `GET https://purlay.app/api/auth/methods` yanıtında `email: true` ve `signUp: "invite-only"` görüldü. Bu, sunucunun e-posta özelliğini açık bildirdiğini gösterir; SMTP teslimatının çalıştığını kanıtlamaz.

İnceleme, gerçek uygulama kabuğunu kullanan mevcut bileşen testleri ve dört geçici yeniden üretim testiyle desteklendi. Geçici testlerde HTTP yanıtları mevcut test altyapısıyla taklit edildi; canlı ortamda davet oluşturulmadı veya e-posta gönderilmedi.

## Değerlendirme

“Davetler” sayfası, e-posta göndermek isteyen yöneticinin işini tamamlamıyor: mevcut gönderim formu çalışma alanı menüsündeki başka bir pencerede kalmış. Sayfa, açık bağlantıların yönetiminde de sayfalama ve iptal sonrası durum sorunları taşıyor.

## Korunacak davranışlar

- E-posta için sunucu uygulaması, Türkçe/İngilizce mektuplar ve adres başına sonuçlar mevcut.
- Davet penceresi birden çok adresi, tekrarları, geçersiz adresleri ve kısmi reddi ele alıyor.
- Arayüz kuyruğa alınmayı teslimat gibi sunmuyor; başarısızlıkta bağlantıyı elle paylaşma imkânı var.
- Üye/yönetici ayrımı, liste yüklenme/hata/boş durumları ve kopyalama hataları için mevcut testler geçiyor.
- Token URL fragment'ında taşınıyor; veritabanında yalnızca özeti tutuluyor.

## Puanlama

| Boyut | Puan | Dayanak |
|---|---|---|
| Görevin tamamlanması | 1/4 | Ayarlar sayfasında e-posta daveti yapılamıyor; başka bir giriş noktası gerekiyor. |
| Durum yönetimi ve geri bildirim | 2/4 | Temel hata durumları var; iptal sonrası bağlantı ve bekleme durumu eksik. |
| Gerçek veriyle yönetim | 1/4 | API'nin sonraki sayfası arayüzden erişilemiyor. |

Tipografi, kontrast, mobil yerleşim ve performans için canlı iç ekran doğrulanmadığından puan verilmedi. Mevcut axe kontrollerinin geçmesi tam erişilebilirlik doğrulaması sayılmadı.

## Bulgular

| ID | Önem | Alan | Konum / kanıt | Mevcut davranış | Önerilen düzeltme | Kullanıcı etkisi |
|---|---|---|---|---|---|---|
| INV-01 | HIGH | E-posta daveti | `apps/web/src/features/settings/pages/invitations.tsx:12`; `apps/web/src/features/sidebar/invite-dialog.tsx:103`, `:148`, `:190`. E-posta açık taklit sunucuyla sayfa render edildi: adres alanı ve gönder düğmesi yok. | Ayarlar sayfasında yalnızca bağlantı oluşturulabiliyor. Gönderim formu başka bir pencerede; bu sayfa onu açan bir eylem veya açıklama da sunmuyor. | Mevcut adres formunu ve sonuç gösterimini ortak davet bileşenine çıkarıp bu sayfada da kullan. E-posta kullanılabilirliği yüklenirken ve sorgu başarısızken açık durum ve yeniden deneme sun. | Davet göndermek için doğru yer olarak görülen sayfada temel görev tamamlanamıyor. |
| INV-02 | HIGH | Açık davetlerin tamamına erişim | `apps/web/src/features/settings/invitations.tsx:56`; `apps/web/src/features/settings/pages/invitations.tsx:75`; `apps/api/src/modules/workspaces/invitations.ts:199`; `packages/types/src/api.ts:73`. `nextCursor` dolu yanıtla test: devam eylemi yok. | Hook yalnızca ilk sayfayı okuyor; sayfa `nextCursor` kullanmıyor. Varsayılan sınır 50. | İmleci kullanan sayfalama veya “Daha fazla yükle” ekle; sonraki sayfa için yüklenme/hata/yeniden deneme durumlarını koru. | 51 veya daha fazla açık bağlantıda eski bağlantıları doğrudan görmek ve iptal etmek mümkün değil. |
| INV-03 | MEDIUM | İptal sonrası durum ve yeni bağlantı | `apps/web/src/features/settings/invitations.tsx:71`, `:86`; `apps/web/src/features/settings/pages/invitations.tsx:32`. Oluştur → iptal et testiyle doğrulandı. | Liste boşalsa bile üstte iptal edilmiş URL ve Kopyala kalıyor. Bağlantı oluştur düğmesi geri gelmiyor. Ayrıca bir bağlantı oluşturulduktan sonra sayfadan ayrılmadan ikinci bir bağlantı oluşturma eylemi yok. | Oluşturulan davetin kimliğini URL ile birlikte tut; aynı davet iptal edilince gösterimi temizle. “Yeni bağlantı oluştur” eylemi sun ve mevcut bağlantıyı değiştirmekle iptal etmenin farkını açık tut. | Kullanıcı çalışmayan bağlantıyı paylaşabiliyor; yeni bir bağlantı için sayfayı terk etmesi gerekiyor. |
| INV-04 | MEDIUM | İptal işleminin geri bildirimi | `apps/web/src/features/settings/invitations.tsx:86`; `apps/web/src/features/settings/pages/invitations.tsx:91`. Bekletilen API yanıtıyla iki tıklama iki istek üretti. | İptal işlemi sürerken düğme etkin kalıyor; satırda bekleme durumu yok. | İşlem durumunu davet kimliğine göre tut; ilgili düğmeyi `busy` yap ve tekrar isteğini engelle. Sonuçta listeyi güncelle, hatada tekrar denemeye izin ver. | Yavaş ağda işlemin alınıp alınmadığı anlaşılmıyor ve gereksiz tekrar istekleri oluşuyor. |

## Düzeltme sırası

**Şimdi:** INV-01 ile e-posta gönderimini Davetler sayfasına getir; mevcut çoklu adres, dil, limit ve kısmi sonuç davranışlarını paylaş. INV-02 ile tüm açık bağlantıları yönetilebilir yap.

**Ardından:** INV-03 ve INV-04 ile iptal/yeniden oluşturma akışını tamamla. Bu dört senaryoyu kalıcı regresyon testlerine ekle; e-posta formunu gerçek tarayıcıda hem dar hem geniş ekranda doğrula.

**Sonraki ürün kararı:** Kime gönderildiği, kabul durumu, yeniden gönderme ve gönderim geçmişi bir yönetim beklentisi olarak değerlendirilmeli. Bugünkü sözleşmede bunlar bulunmuyor; yalnızca sayfa tasarımıyla eklenemez. Adres saklama, görünürlük ve saklama süresi kararları gerekir. SMTP kabulü, teslimat ve çalışma alanına katılma ayrı olaylar olarak adlandırılmalı.

## Çalıştırılan kontroller

- `git pull --ff-only`: `962ee2f9` → `d0d29581`; başarılı. Önceden mevcut `.superpowers/` dosyalarına dokunulmadı.
- Canlı sayfa HTTP GET: 200, uygulama HTML'i. Chromium navigasyonu: `/sign-in` yönlendirmesi.
- Canlı `GET /api/auth/methods`: `email: true`.
- `bun --no-env-file --env-file=.env.test test apps/web/src/features/settings/pages/invitations.test.tsx apps/web/src/features/sidebar/invite-dialog.test.tsx apps/api/src/modules/workspaces/invitation-mail.test.ts --isolate`: **36 geçti, 0 başarısız**.
- Geçici `invitations.audit.test.tsx` ile yukarıdaki dört kusurun mevcut davranışını doğrulayan kontroller: **4 geçti, 0 başarısız**. Bunlar doğru ürün davranışının testleri değil, kusurların yeniden üretimidir. Geçici dosya inceleme sonunda kaldırıldı.

## Doğrulama sınırları

- Üyelik gerektiren canlı sayfada oturum yok; canlı iç ekranın masaüstü/mobil görünümü, klavye akışı ve yakınlaştırması kontrol edilmedi.
- Gerçek SMTP gönderimi, teslimat ve üretim logları kontrol edilmedi; e-posta özelliğinin açık görünmesi teslimat garantisi değil.
- Veritabanlı entegrasyon ve uçtan uca testleri çalıştırılmadı; yerel ortamda Docker komutu bulunmuyor.
- İncelenen kodun canlı dağıtımla aynı commit olduğu doğrulanmadı. Kod ve bileşen bulguları güncel yerel `main` için geçerli.

## Kusur olarak değerlendirilmemesi gerekenler

- Eski bağlantıyı tekrar kopyalayamamak D-115'in token'ın yalnızca oluşturma yanıtında verilmesi kararına dayanıyor. Çözüm ham token'ı kalıcı olarak saklamak yerine yeni bağlantı oluşturmayı kolaylaştırmalı.
- Davette rol seçiminin olmaması ve bağlantının belirli adrese bağlanmaması D-179 §5'in mevcut ürün kararı. Katılan kişi üye olur; rol daha sonra değiştirilir.
- Gönderildi/teslim edildi/geçerli üyeye ait gibi durumların yokluğu mevcut modelin sınırı; bunları gözlenmiş bir teslimat hatası olarak sunmak doğru olmaz.

## İlk incelemenin kararı

**Block — incelenen davet yönetimi akışı için.** E-posta davetinin sayfada bulunmaması ve eski açık bağlantıların erişilememesi çözülmeli. Bu karar tüm ürünün erişilebilirliği veya canlı SMTP hizmeti hakkında bir hüküm değildir.

## Uygulama sonrası durum

Çalışma dalı: `fix/workspace-invitations`. Kullanıcının düzeltme isteği üzerine ürün kodu, regresyon testleri, UX dokümanı ve changelog güncellendi.

| Bulgu | Durum | Uygulama ve doğrulama |
|---|---|---|
| INV-01 | Düzeltildi | `features/invitations/invitation-form.tsx`, Davetler sayfası ve hızlı davet penceresi tarafından ortak kullanılıyor. Çoklu adres, geçersiz/tekrarlı adres, günlük limit, kısmi ret, ağ hatası, yeniden deneme ve bağlantı alternatifi mevcut. |
| INV-02 | Düzeltildi | `useInfiniteQuery` API'nin imlecini izliyor. Gerçek API üzerinde 51 açık davet oluşturup eski davete ulaşma ve iptal etme testi iki tema ve iki genişlikte geçti. |
| INV-03 | Düzeltildi | Oluşturulan davetin kimliği URL ile birlikte tutuluyor. Aynı davet iptal edildiğinde kopyalama alanı temizleniyor. Başka daveti iptal etmek alanı temizlemiyor; yeni bağlantı oluşturma eylemi sayfada kalıyor. |
| INV-04 | Düzeltildi | İptal durumu satır kimliğiyle izleniyor; ilgili düğme beklerken devre dışı. Başarı bildirilip satır kaldırılıyor; başarısızlık tekrar denemeye izin veriyor. |

Ek olarak, pencere kapandıktan sonra gelen oluşturma yanıtının token'ı yeniden göstermesi ve mail durumu yenilenemediğinde yazılmış adreslerin kaybolması düzeltildi. Başarılı iptalden sonra liste yenilemesi başarısız olsa bile iptal edilmiş satır geri gelmiyor. Bu durumlar kalıcı bileşen testleriyle doğrulandı.

### Tamamlanan doğrulama

- Davet sayfası, hızlı davet penceresi, kurulum davet adımı, stil sözlüğü ve iki dilin sözleşmelerini kapsayan hedefli test komutu: **4.579 geçti, 0 başarısız**. Türkçe formun `locale: tr` göndermesi ayrıca doğrulandı.
- Davet ve mail sunucu entegrasyonları: **48 geçti, 0 başarısız**.
- Chromium'da iki tema × iki genişlik: **25 geçti, 3 kasıtlı atlama**. Atlamalar, aynı SMTP senaryosunun yalnızca bir projede çalıştırılması içindir; davet yönetimi ve erişilebilirlik kontrolleri dört projede de geçti.
- Yeni `e2e/invitation-mail.e2e.ts`, izole veritabanı ve SMTP alıcısıyla gerçek akışı doğruluyor: Davetler sayfasından iki alıcıya mektup, mektuptaki bağlantıyla yeni hesap için e-posta doğrulaması ve çalışma alanına üye olarak katılım. HTTP gönderim sonucu taklit edilmedi. Son mobil yazı boyutu değişikliği sonrası bu test yeniden geçti.
- Aynı testte 1440, 390 ve 320 CSS pikselde taşma ve axe denetimi geçti. Dar ekranlarda adres ve bağlantı alanlarının hesaplanan yazı boyutu en az 16 piksel olarak doğrulandı.
- Masaüstü ve mobil ekran görüntüleri incelendi: [masaüstü](invitations-desktop.png), [mobil](invitations-mobile.png).
- İki TypeScript derleyicisi, ESLint, Knip, Prettier, doküman referansları ve `git diff --check`: başarılı.
- Kaynak haritalı üretim derlemesi ve `budget:web`: başarılı; ilk JavaScript 245,70 KB gzip, 400 KB sınırının altında.

### Son kapı

`bun run test:all` koşusunda **19.146 test geçti, 1 test atlandı, 0 test başarısız oldu**; iki Compose test dosyası Docker CLI'ı PATH'te olmadığı için başlatılamadı ve komut bu iki ortam hatasıyla kod 1 döndü. Sonuç, başarılı bir `test:all` komutu gibi raporlanmıyor.

Makinede mevcut `/Applications/Docker.app/Contents/Resources/bin/docker` bulundu. Yalnızca ilgili test sürecinin PATH'ine bu dizin eklenerek `scripts/dockhand-compose.integration.test.ts` ve `scripts/production-compose.integration.test.ts` tekrar çalıştırıldı: **40 geçti, 0 başarısız**, çıkış kodu 0. Böylece çalıştırılamayan iki dosyanın kontrolleri de doğrulandı; ürün kodunda veya kullanıcının kalıcı ortam ayarlarında değişiklik gerekmedi.

Genel raporda fonksiyon kapsamı **%99,90**, satır kapsamı **%99,87**; değişen davet formu, hook, ayarlar sayfası, adres alanı ve hızlı davet penceresinin her birinde fonksiyon ve satır kapsamı **%100**.

**Uygulama sonrası karar: Approve — incelenen ve düzeltilen davet akışı için.** INV-01–INV-04 ve inceleme sırasında bulunan iki ek durum hatası giderildi; uygulama, tarayıcı, SMTP ve kapsam kanıtları yukarıda kayıtlı.

Canlı ortama dağıtım yapılmadı. Üretim SMTP sağlayıcısının teslimatı, tarayıcılar arası tam uyumluluk ve ekran okuyucuyla manuel kullanım bu doğrulamanın kapsamı dışında.
