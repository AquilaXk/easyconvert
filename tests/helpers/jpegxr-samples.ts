/**
 * JPEG XR (HD Photo, .wdp) files for tests. They were encoded by the JPEG XR reference encoder (the jpegxr demonstration program in
 * GhostPDL 10.08.0, directory jpegxr/) from flat PNM pictures. That program writes a container directory that no decoder accepts on a
 * 64-bit machine (the IMAGE_OFFSET entry points 8 bytes early and the next entry is shifted), so each codestream was put in a container
 * written by hand from the layout of ITU-T T.832 Annex A: an IFD of PIXEL_FORMAT, IMAGE_WIDTH, IMAGE_HEIGHT, IMAGE_OFFSET and
 * IMAGE_BYTE_COUNT. Each file was decoded by the reference decoder of the same program and by GhostXPS 10.08.0 (an XPS page with the
 * file as its image brush, read back with pdfimages -list), which agree on the size in the comment of each constant.
 */

/** A long header (the width is past 65,536): 70,000 x 1 grey pixels of one value. */
export const JPEG_XR_WIDE_70000_BY_1 = Buffer.from(
  'SUm8AQgAAAAFAAG8AQAQAAAASgAAAIC8BAABAAAAcBEBAIG8BAABAAAAAQAAAMC8BAABAAAAWgAAAMG8BAABAAAApAYAAAAAAAAkw91vA07+S7GFPXd2jckN' +
  'V01QSE9UTwARAUABAAERbwAAAAAAgCAIAAAEb/8AAQAAAQAAAAAAAAAAAAEgAAAAAAAAEAAAAAAgAABAghEkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk' +
  'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkg=',
  'base64'
);

/** A window cut from a 40 x 30 picture: the container states 40 x 30 and the bitstream 37 x 22. */
export const JPEG_XR_WINDOWED_37_BY_22 = Buffer.from(
  'SUm8AQgAAAAFAAG8AQAQAAAASgAAAIC8BAABAAAAKAAAAIG8BAABAAAAHgAAAMC8BAABAAAAWgAAAMG8BAABAAAALQIAAAAAAAAkw91vA07+S7GFPXd2jckN' +
  'V01QSE9UTwARAeBxACQAFQwhyWAAoAAKAACgAAAABG//AAEAAAEAGoohK0QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMhpppW5/o1siLwyIvHTSiZD/DIf8tms' +
  'Vs3qZB/TprqZB/rpvK6b1dN6um4um4ls5Ua2QXqZP+rpuJk/6mTvK6bi6biZO8rpuJkv6um4um4um4um4um4oAAAAAAAAAAAAAAAAAAAAAAAAAAFkv6mX+rz' +
  '4vPiZf6mW8l58XnxefF4+rx9Xj6vH1ePF48XjxGO8kY71ePF48RjvUY71ePF48XjxePF48XjxePF48XjxePFAAAAAAAAAAAAAAAAAAAmO9Rjvrx4vHiMd9QK' +
  'fjxD+2R+PF48XjxePF48Q/tkfjxD+2RmO1GO1ePF48RjtUCn48Q/tkfjxePF48XjxePEP7ZH48V+2RwAAAAAAAAAAJjtXjxGO1ePF48XjxePF48RjtXjxRQf' +
  'lkfjxePEH5ZGH5ZGQdq48RB2rjxceLjxceLjxEHauPEKj/LI+PFx4j/LI39sjgAAePFx4uPFx4uPFx4uPFx4uPFx4n9sjf2yPjxceJ/bI/myPwdeDrwdeDrw' +
  'deDrwdeDrwdeDr5sj+bI/B14OvmyP5sjgAGmLNqMWbV8HXg68HXg68HRdlkfg6Lssj8HXg6+bI/myPwdF2WR/NkY9tkuvwdeDrwdeDrwdF2WR+DouyyPwdeD' +
  'r5sj+bI/B0XZZH82Rj22S6w=',
  'base64'
);

/** One pixel. */
export const JPEG_XR_SINGLE_PIXEL = Buffer.from(
  'SUm8AQgAAAAFAAG8AQAQAAAASgAAAIC8BAABAAAAAQAAAIG8BAABAAAAAQAAAMC8BAABAAAAWgAAAMG8BAABAAAAoAAAAAAAAAAkw91vA07+S7GFPXd2jckN' +
  'V01QSE9UTwARAcBxAAAAAGAAoAAKAACgAAAABG//AAEAAAEAGoohK0QAhgAAIBAMAAAAAAAAAAAABDAAAQCAYAAyGmmlbn+jWyIvDIi8dNKJkP8QF9NKId/j' +
  '3VkH9OmuptW+W7r6byh3ccy7fczLW25ly1s5Da2T/qZP+q2N1NP+qBLtjdR43O5bTvVbGxGVb+bl9NxDu7uXb+TE1t+Taw==',
  'base64'
);
