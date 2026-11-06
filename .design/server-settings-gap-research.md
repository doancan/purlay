# Sunucu yönetimi: kapsam araştırması ve eksik analizi

Tarih: 2026-11-06. İncelenen yerel commit: `268b9651`. Bu çalışma, önceki form ve hata durumu düzeltmelerine ek olarak yönetim panelinin işlevsel kapsamını değerlendirir.

## Sonuç

Mevcut Sunucu ekranı tam bir işletim ve yönetim konsolu değil; esas olarak kimlik sağlayıcıları, SMTP ve birkaç erişim politikasından oluşuyor. Önceki inceleme bu formların doğru çalışmasını doğruladı, fakat sunucu yöneticisinin günlük işlerini tamamlayıp tamamlayamadığını yeterince sorgulamadı.

Eksikleri ikiye ayırmak gerekiyor: Purlay'da servisi/CLI'ı/verisi olan fakat yönetici ekranı bulunmayan işler ve henüz ürün davranışı olarak tanımlanmamış yeni yetenekler. İlk grupta bile yeni yetkili okuma/yazma API'leri gerekebilir; bir CLI'ın bulunması, tarayıcıya doğrudan bağlanabilen bir API'ın bulunduğu anlamına gelmiyor.

## Kanıt ve yöntem

- Yerelde açık gerçek sayfadan on kart okundu: GitHub ile giriş, Google ile giriş, tek oturum açma, e-posta, GitHub App, hesap açma politikası, giriş yöntemi, oturum süresi, çalışma alanı oluşturma politikası ve hesaplar.
- Oturum açıkken gerçek `GET /api/server/settings` yanıtının alanları kontrol edildi. Genel durum, görevler, kota yönetimi veya sunucu denetim kaydı bu yanıtta yok.
- Sayfanın ve gezinmenin kaynakları: `apps/web/src/features/settings/pages/server.tsx`, `apps/web/src/features/settings/sections.ts`. Sunucu yönetimi tek bir sayfa; kullanıcı ve çalışma alanı ayarları ayrı yetki gruplarında.
- API yüzeyi `apps/api/src/platform/module-kit/core-claims.ts` ve `apps/api/src/ingress/http/app.ts` üzerinden incelendi. Mevcut `/api/server/*` yolları sağlayıcılar, politikalar, hesap arama ve askıya almayla sınırlı.
- Resmî Mattermost, Rocket.Chat ve Zulip belgeleriyle karşılaştırıldı. Bir ürünün özelliğinin bulunması Purlay'a otomatik olarak ekleme gerekçesi sayılmadı; mevcut kapsam ve mimari kararlar ayrıca kontrol edildi.

## Karşılaştırmadan çıkan tasarım ilkeleri

[Mattermost System Console](https://docs.mattermost.com/administration/config-settings) kimlik doğrulama yanında kullanıcı yönetimi, ortam, raporlama ve uyumluluğu ayrı bölümlere ayırıyor. [Ortam ayarları](https://docs.mattermost.com/administration-guide/configure/environment-configuration-settings) depolama, SMTP, push, günlükler ve performans görünürlüğünü de kapsıyor; bazı ayarların yeniden başlatma gerektirdiğini açıkça belirtiyor. Purlay için çıkarım: bağlantı formlarının yanında işletim görünürlüğü ve ayarın ne zaman uygulanacağı da gösterilmeli.

[Rocket.Chat e-posta yönetimi](https://docs.rocket.chat/docs/configure-email), SMTP alanlarını ayrı girdiler olarak sunuyor ve kaydedilmiş yapılandırmayla kullanıcıya test postası gönderme eylemi sağlıyor. [Genel ayarlar](https://docs.rocket.chat/general) kurulum kimliği ve uygulama davranışlarını gruplayabiliyor. Purlay için çıkarım: teknik SMTP URL'si tek seçenek olmamalı; mevcut bağlantıyı sırları tekrar istemeden sınamak ayrı bir yönetim işi.

[Zulip sunucu yapılandırması](https://zulip.readthedocs.io/en/latest/production/settings.html) ile [organizasyon ayarları](https://zulip.com/help/customize-organization-settings) kurulum düzeyi ile organizasyon düzeyini ayırıyor. Her altyapı değişkenini tarayıcıdan düzenletmiyor. Purlay için çıkarım: panel genişlemeli, ancak çalışma alanı tercihlerinin veya altyapı sırlarının rastgele toplandığı bir ekran olmamalı.

## Eksik matrisi

| Alan | Purlay'daki durum ve kanıt | Gerekli yönetim işi | Öncelik / ek iş |
|---|---|---|---|
| Sunucu özeti ve sağlık | `platform/readiness.ts`, `/health/ready`, `platform/metrics.ts` ve korumalı `/metrics` var; yönetici özeti yok. Genel sağlık yanıtı ayrıntıları bilerek gizliyor. | Sürüm, etkin modüller, veritabanı/migrasyon durumu, depolama ve bildirim yapılandırması, son kontroller ve eylem gerektiren sorunlar. | İlk aşama. Mevcut servislerden sınırlı ve gizli değer içermeyen yönetici yanıtı oluşturulmalı. Tek bir yeşil sağlık kontrolü bütün bileşenler sağlıklıymış gibi sunulmamalı. |
| Sunucu denetim kaydı | `modules/audit/server-audit.ts` işlemleri `server_audit_log` tablosuna ve yapılandırılmış günlüğe yazıyor; üretim kaynaklarında bu tabloyu okuyan yönetici ekranı/API'ı yok. Mevcut Ayarlar → Denetim kaydı çalışma alanına ait. | Kimin, hangi sunucu ayarını veya hesabı, ne zaman değiştirdiği; aktör/eylem/tarih filtreleri ve sayfalama. | İlk aşama. Kayıt üretimi var; yetkili okuma servisi, sözleşme ve ekran yeni. Gizli ayar değerleri gösterilmemeli. |
| Çalışma alanları ve kotalar | Sunucu genelinde çalışma alanı listesi yok. `cli/storage-quota.ts` kotayı yönetiyor; çalışma alanı sahibi `pages/storage.tsx` üzerinden yalnızca kullanımını görüyor. | Tüm alanların adı, durumu, sahipleri ve depolama kullanımı; arama, kota değiştirme ve kotası dolan alanları bulma. | İlk aşama. Kota iş mantığı tekrar kullanılabilir; sunucu yöneticisine özel liste/yazma API'ları gerekli. Bu yetki özel mesajları okumak anlamına gelmemeli. |
| Bakım ve zamanlanmış işler | `job_runs` tablosunda son başarı ve hata bilgisi, `cli/jobs.ts` içinde `jobs:status`, `modules/jobs/report.ts` içinde gecikme değerlendirmesi var. Panelde görünmüyor. | Geciken/başarısız işler, son başarı zamanı ve temizlenmiş hata özeti. | İlk aşama. Önce okuma ekranı. Sonradan eklenecek çalıştırma eylemi ayrı yetki, denetim ve eşzamanlılık tasarımı gerektirir. Tarayıcıdan serbest shell komutu çalıştırma önerilmiyor. |
| Kullanıcılar ve yöneticiler | `pages/server-accounts.tsx` ve `modules/users/suspension.ts` arama, askıya alma/kaldırma sunuyor. Yönetici durumu gösteriliyor. Sonuçlar sabit üst sınırla dönüyor; gezinilebilir bir yönetici envanteri değil. Yönetici kurtarma işlemleri `CONFIG.md` içinde operatör komutu/SQL ile açıklanıyor. | Sayfalı kullanıcı listesi, durum filtreleri, hesap ayrıntısı ve üyelikler; gerekçeli oturum iptali, yönetici atama/kaldırma. | Envanter ilk aşama; yeni hassas eylemler ikinci aşama. Yönetici atama/oturum iptali mevcut ekranın hazır birer özelliği sayılmamalı; yeni API ve son yöneticiyi koruma kuralları gerekli. |
| E-posta işletimi | SMTP bağlantısını dene/kaydet ve bağlantıyı kes var. Her yeni sınama aday URL ve kimlik bilgilerini istiyor. Ayrı bir mevcut bağlantıyı sınama veya teslimat geçmişi ekranı yok. | Host/port/TLS/kullanıcı/şifre/gönderen girdileri; kaydedilmiş bağlantıyı tekrar deneme; son sınama zamanı ve anlaşılır sonuç. | İlk aşama. Alanları mevcut URL sözleşmesine dönüştürmek mümkün; kaydedilmiş bağlantı testi yeni bir yönetici işlemi. Rölenin kabulü ile gerçek posta kutusuna ulaşma ayrılmalı. Kalıcı teslimat geçmişi veya kuyruk zaten varmış gibi sunulmamalı. |
| Erişim ve güvenlik politikaları | Davetle/açık kayıt, MFA zorunluluğu, parolayla giriş ve oturum süreleri var. Alan adı izin listesi, yeni hesap onayı ve sunucu yöneticisinin kullanıcı oturumlarını yönetmesi bu sözleşmelerde yok. | Gereksinime göre doğrulanmış e-posta alan adı kısıtları ve hesap kabul akışı; kullanıcı oturumu iptali. | İkinci aşama, yeni ürün davranışı. Yalnızca form eklemek yeterli değil; kayıt, davet, OAuth/OIDC ve açık oturumların tutarlı uygulanması gerekir. |
| Veri ve saklama | Çalışma alanı sahibi için saklama ve dışa aktarma zaten `pages/data.tsx` içinde var. Sunucu genelinde durum görünümü yok. | Alanların saklama politikaları ve başarısız dışa aktarma/silme işleri için özet; mevcut yetkili akışlara bağlantı. | İlk aşamada görünürlük. Global saklama varsayılanı/üst sınırı istenirse miras ve öncelik kuralları ikinci aşamada tanımlanmalı. Mevcut sahip politikası sessizce geçersiz kılınmamalı. |
| Yedek ve kurtarma görünürlüğü | `DEPLOY.md` ile dağıtım/yedek betikleri süreçleri tanımlıyor. Panele güvenilir son yedek/geri yükleme doğrulaması besleyen bir yönetici sözleşmesi yok. | Yedekleme yapılandırmasının ve mevcutsa doğrulanmış son yedeğin durumu; operatör kurtarma yönergesine erişim. | İkinci aşama. İşletim sisteminden güvenilir durum aktarımı gerekir. Veri kaynağı yokken zaman veya başarı göstergesi uydurulmamalı; ilk sürümde web üzerinden tek tıklamayla restore önerilmiyor. |
| Sistem, modüller ve bildirim altyapısı | `CONFIG.md` içinde `APP_URL`, `MODULES`, depolama, proxy, varsayılan dil ve Web Push ayarları var. Bazıları dağıtım ayarı veya kriptografik sır. Panelde bunların işletim görünümü yok. | Etkin modüller ve yetenekler, uygulanan sınırlar, push yapılandırılmış mı, ayarın kaynağı ve yeniden başlatma gereksinimi. | İlk aşamada salt okunur envanter. Çalışırken değiştirilebilen ürün tercihleri ayrıca ele alınmalı. `ENCRYPTION_KEY`, DB parolası, S3/VAPID sırları tarayıcıya taşınmamalı. |
| Genel kimlik ve destek | Çalışma alanı adı değiştirilebiliyor. Ayrı sunucu görünen adı/destek iletişimi için kapsamlı bir yönetim modeli yok; `APP_URL` ise açıkça dağıtım ayarı. | Birden çok alan kullanan kurulumda sunucu kimliği ve destek bağlantısı; kurulum adresinin görünmesi. | İkinci aşama için aday. Sunucu ve çalışma alanı markası ayrı tanımlanmalı; tam white-label özelliği var kabul edilmemeli. `APP_URL` için doğrudan canlı düzenleme mevcut karara aykırı. |

## Önerilen bilgi mimarisi

Tek uzun form yerine Sunucu grubunun kendi alt sayfaları olmalı:

1. Genel bakış — sağlık, sürüm, etkin modüller ve yapılacak işler.
2. Kullanıcılar ve yöneticiler — hesap envanteri ve yetkili işlemler.
3. Çalışma alanları — alan envanteri, durum ve kotalar.
4. Kimlik ve güvenlik — mevcut sağlayıcılar, kayıt/giriş ve oturum politikaları.
5. E-posta — SMTP yapılandırması, mevcut bağlantı testi ve teşhis.
6. Depolama ve veri — kullanım, saklama görünürlüğü ve dışa aktarma durumları.
7. Entegrasyonlar ve bildirimler — GitHub App ve sunucunun bildirim yetenekleri.
8. İşletim ve bakım — görevler, yedekleme/kurtarma bilgisi ve altyapı envanteri.
9. Sunucu denetim kaydı — çalışma alanının kaydından ayrı, sunucu işlemleri.

Bu bir öneridir; bu alt sayfalar şu an mevcut değildir. Sunucu grubu kurulumun tamamını yönettiğinden, çalışma alanı seçmeden erişilebilir bir giriş noktası da tasarlanmalı. Mevcut yolun `/w/:slug/settings/server` olması bunu bugün çalışma alanı bağlamına bağlıyor.

## Uygulama sırası

İlk paket: sunucu özeti, sunucu denetim kaydı, çalışma alanı/kota envanteri, bakım işlerinin okunması ve kayıtlı SMTP bağlantısının test edilmesi. Mevcut veri ve iş mantığının görünürlüğünü tamamlar; yeni altyapı kurmayı gerektirdiği varsayılmaz.

İkinci paket: yönetici yetki yönetimi, kullanıcı oturumu iptali, alan adı/kabul politikaları, sunucu kimliği ve güvenilir yedek durum aktarımı. Bunlar yeni güvenlik ve ürün sözleşmeleridir; mevcut davranışlar ve yetki sınırlarıyla birlikte tasarlanmalı.

Yeni API'lar sunucu yöneticisi guard'ını kullanmalı; sözleşmeler `@purlay/types` içinde tanımlanmalı. Liste ekranları sayfalı olmalı. Yetki reddi, son yöneticiyi kaybetme, eşzamanlı kayıtlar, kısmi hata, uzun listeler ve salt okunur dağıtım ayarları ayrı ayrı test edilmeli.

## Eklenmesi gerekçelendirilmeyen seçenekler

- Sırf rakipte bulunduğu için SAML, video/görüşme, plugin mağazası veya özel emoji yönetimi eklemek: `PRD.md` bunları kapsam dışı tutuyor.
- DB adresi, şifreleme anahtarı ve altyapı sırlarını bir web formuna dönüştürmek: mevcut kurulum ve kurtarma mimarisini değiştirir.
- Sabit protokol, HTTP, socket ve dosya sınırlarını rastgele düzenlenebilir yapmak: `CONFIG.md` bazılarını sözleşme veya veritabanı kısıtı olarak özellikle sabit tutuyor.
- Çalışma alanı sahibinin saklama politikasını veya kişisel bildirim tercihlerini ikinci bir sunucu ayarıyla belirsizleştirmek.

## Kapsam sınırı

Bu araştırma kaynak/API incelemesi ve yerel yönetici ekranının okunmasına dayanıyor. Yeni ürün özelliği uygulanmadı. Rakiplerin üretim hesaplarına giriş yapılmadı; karşılaştırma yukarıdaki resmî belgelere dayanıyor. Yerel SMTP sunucusunun kurulmuş olması, üretim e-posta teslimatı veya yedeklerin çalıştığına dair kanıt sayılmıyor.
