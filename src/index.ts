import { CodeGeneratorRequest, CodeGeneratorResponse } from "google-protobuf/google/protobuf/compiler/plugin_pb";
import { EntityIndex } from "./EntityIndex";
import * as ejs from "ejs";
import { MESSAGE_TYPE, ENUM_TYPE, getTypeName } from "./FieldTypes";

const SPECIFIC_TYPES: { [index: string]: string } = {
  DoubleValue: "number",
  FloatValue: "number",
  Int64Value: "number",
  UInt64Value: "number",
  Int32Value: "number",
  UInt32Value: "number",
  BoolValue: "boolean",
  StringValue: "string",
  BytesValue: "Uint8Array",
  Timestamp: "Date",
  Empty: "{}"
}

const FILES_TO_EXCLUDE = [
  "google/protobuf/timestamp.proto",
  "google/protobuf/wrappers.proto",
  "google/protobuf/empty.proto",
  "google/protobuf/any.proto"
]

const allStdinBuffer = (): Promise<Buffer> => new Promise((resolve, reject) => {
  const ret: Buffer[] = [];
  let len = 0;

  const stdin = process.stdin;
  stdin.on("readable", function () {
    let chunk;

    while ((chunk = stdin.read())) {
      if (!(chunk instanceof Buffer)) reject(new Error("Did not receive buffer"));
      ret.push(chunk as Buffer);
      len += chunk.length;
    }
  });

  stdin.on("end", function () {
    resolve(Buffer.concat(ret, len));
  });
})

const getCodeGenRequest = async () => {
  const inputBuff = await allStdinBuffer()
  const typedInputBuff = new Uint8Array(inputBuff.length);
  typedInputBuff.set(inputBuff);
  return CodeGeneratorRequest.deserializeBinary(typedInputBuff);
}

const generateFile = (fileName: string, content: string, codeGenResponse: CodeGeneratorResponse) => {
  const outputFileName = fileName.replace(".proto", ".ts")
  const thisFile = new CodeGeneratorResponse.File();
  thisFile.setName(outputFileName);
  thisFile.setContent(content);
  codeGenResponse.addFile(thisFile);
}

const moduleAliasName = (filePath: string): string => filePath.replace(".proto", "").split("/").slice(-1)[0]

const hasSteamRpc = (sericesList: any): boolean =>{
  const svcs = sericesList.find((list: any) => {
    return list.methodList.find((method: any) => method.clientStreaming || method.serverStreaming)
  })
  return !!svcs
}

const extractType = (msgType: string): string => msgType.split('.').slice(-1)[0]

const findMessageByType = (entityIndex: EntityIndex) => (msgType: string, moduleName: string): string => {
  const name = extractType(msgType)
  if (Object.keys(SPECIFIC_TYPES).indexOf(name) !== -1) { return SPECIFIC_TYPES[name] }
  const msg = entityIndex.findMessageEntity(name)
  if (msg.resultFieldType) {
    return findMessageByType(entityIndex)(msg.resultFieldType, moduleName)
  }
  if (msg.moduleName === moduleName) { return msg.printName }
  return `${moduleAliasName(msg.moduleName)}.${msg.printName}`
}

const isSpecificFieldType = (field: any): boolean => {
  if (field.type !== MESSAGE_TYPE) { return false }
  const name = extractType(field.typeName)
  return Object.keys(SPECIFIC_TYPES).indexOf(name) !== -1
}

const fieldType = (entityIndex: EntityIndex) => (field: any, moduleName: string): string => {
  if ((field.type === MESSAGE_TYPE) || (field.type === ENUM_TYPE)) {
    return findMessageByType(entityIndex)(field.typeName, moduleName)
  }
  return getTypeName(field.type)
}

const isNoSpecificImport = (fileName: string) => FILES_TO_EXCLUDE.indexOf(fileName) === -1

const isSimpleType = (field: any): boolean => field.type !== MESSAGE_TYPE

const toLower = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1)

const snakeToCamel = (str: string): string =>
  str.replace(/(\_\w)/g, (m) => m[1].toUpperCase())

const render = (obj: any, entityIndex: EntityIndex) => new Promise((resolve, reject) => {
  const helpers = {
    snakeToCamel,
    toLower,
    isSpecificFieldType,
    isNoSpecificImport,
    isSimpleType,
    fieldType: fieldType(entityIndex),
    moduleAliasName,
    hasSteamRpc,
    moduleImportName: (filePath: string): string => filePath.replace(".proto", ""),
    findMessageByType: findMessageByType(entityIndex)
  }
  ejs.renderFile(`${__dirname}/templates/module.ejs`, { obj, helpers } , (err, str) => {
    err ? reject(err) : resolve(str)
  })
})

const main = async (): Promise<void> => {
  try {
    const codeGenRequest = await getCodeGenRequest();
    const entityIndex = new EntityIndex(codeGenRequest.getProtoFileList());
    const contents: any = {}
    const promises = codeGenRequest.getProtoFileList().map(async (protoFileDescriptor) => {
      contents[protoFileDescriptor.getName()] = await render(protoFileDescriptor.toObject(), entityIndex)
    })
    await Promise.all(promises)

    const codeGenResponse = new CodeGeneratorResponse();

    codeGenRequest.getFileToGenerateList().forEach((fileName) => {
      if (FILES_TO_EXCLUDE.indexOf(fileName) === -1) {
        generateFile(fileName, contents[fileName], codeGenResponse)
      }
    })

    process.stdout.write(new Buffer(codeGenResponse.serializeBinary()));
  } catch (err) {
    console.error("protoc-gen-ts-interfaces error: " + err.stack + "\n");
    process.exit(1);
  }
}

main()
