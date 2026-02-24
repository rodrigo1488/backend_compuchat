import path from "path";
import multer from "multer";
import fs from "fs";

const publicFolder = path.resolve(__dirname, "..", "..", "public");
const chatMediaFolder = path.resolve(publicFolder, "chat-media");

export default {
  directory: chatMediaFolder,
  storage: multer.diskStorage({
    destination: async function (req, file, cb) {
      if (!fs.existsSync(chatMediaFolder)) {
        fs.mkdirSync(chatMediaFolder, { recursive: true });
        fs.chmodSync(chatMediaFolder, 0o777);
      }
      return cb(null, chatMediaFolder);
    },
    filename(req, file, cb) {
      const timestamp = new Date().getTime();
      const ext = path.extname(file.originalname);
      const fileName = `${timestamp}_${req.params.id}${ext}`;
      return cb(null, fileName);
    }
  }),
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/webp"
    ];

    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only JPEG, PNG, GIF and WEBP are allowed."));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  }
};
