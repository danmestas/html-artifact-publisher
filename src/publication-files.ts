/** Public exports own their bytes; they never reference private blob delivery URLs. */
export const publicationPrefix = (id: string) => `publications/${id}/`;
export const publicationManifest = (id: string) => `${publicationPrefix(id)}manifest`;
export const publicationFile = (id: string, path: string) => `${publicationPrefix(id)}files/${path}`;
export const publicId = (id: string) => /^[A-Za-z0-9_-]{12}$/.test(id);
export const publicPath = (path: string) => path.length > 0 && path.length <= 255 &&
  !/[\\\0?#]/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');

export async function deletePublicationFiles(bucket: R2Bucket, id: string): Promise<void> {
  // Remove the visibility marker first. Failed cleanup never leaves a partial site public.
  await bucket.delete(publicationManifest(id));
  for (;;) {
    const page = await bucket.list({ prefix: publicationPrefix(id), limit: 1000 });
    if (!page.objects.length) return;
    await bucket.delete(page.objects.map(object => object.key));
  }
}
