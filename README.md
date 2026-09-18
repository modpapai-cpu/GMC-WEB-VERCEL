# GMC v8 — plans/image content switch

Base: GMC v8.

Product content can be either PLANS & PRICES or IMAGE. When IMAGE is selected, the image URL is saved as `imageUrl` and displayed in the same content/pricing area on the product page. The admin product list also shows the selected image.

Run:
`npm install`
`npm start`

Admin: `/admin.html`
Products: `/product.html`


### Google Drive images
1. Upload the image to Google Drive.
2. Right-click it → Share.
3. Under General access choose **Anyone with the link** and **Viewer**.
4. Copy the sharing link and paste it into the product IMAGE field.
The server converts common Drive links (`/file/d/.../view`, `open?id=...`, `uc?id=...`) to a Drive download URL automatically.
